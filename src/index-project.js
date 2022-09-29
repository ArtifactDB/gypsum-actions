/**
 * Index a version of a gypsum project. This mostly involves creating some
 * summary JSON files for each project version, given that gypsum doesn't have
 * any search capabilities.
 *
 * We expect the following environment variables to be available:
 *
 * - R2_ACCOUNT_ID, the account id for Cloudflare's R2 storage.
 * - R2_ACCESS_KEY_ID, an authorized API key for Cloudflare R2 operations.
 * - R2_SECRET_ACCESS_KEY, an authorized API secret for Cloudflare R2 operations.
 * - GITHUB_TOKEN, a token with read access to the GitHub CI repository reunning this script.
 *
 * In addition, we expect the following command-line variables:
 *
 * 1. The name of the R2 bucket of interest.
 * 2. The full name (owner/repo) of the GitHub CI repository (i.e., the one containing this script).
 * 3. The issue number.
 * 4. A path to a file containing the indexing parameters: this is typically the issue body.
 */

import S3 from 'aws-sdk/clients/s3.js';
import * as fs from "fs";
import "isomorphic-fetch";

import * as utils from "./utils.js";
import * as internal from "./internal.js";

process.exitCode = 1;

if (!process.env.R2_ACCOUNT_ID || 
        !process.env.R2_ACCESS_KEY_ID || 
        !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("missing R2 credentials");
}

const s3 = new S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: `${process.env.R2_ACCESS_KEY_ID}`,
    secretAccessKey: `${process.env.R2_SECRET_ACCESS_KEY}`,
    signatureVersion: 'v4',
});

const token = process.env.GH_BOT_TOKEN;
if (!token) {
    throw new Error("missing GitHub bot token");
}

if (process.argv.length - 2 != 4) {
    throw new Error("expected 4 arguments - BUCKET_NAME, REPO_NAME, ISSUE_NUMBER, PARAMETER_PATH");
}
const bucket_name = process.argv[2];
const repo_name = process.argv[3];
const issue_number = process.argv[4]; 
const param_path = process.argv[5]; 

try {
    // Fetching the issue data.
    let body = JSON.parse(fs.readFileSync(param_path).toString());
    let project = body.project;
    let version = body.version;
    let writes = [];

    // Making sure the lock exists.
    let lockpath = internal.lock(project, version);
    {
        let lck = s3.headObject({ Bucket: bucket_name, Key: lockpath });
        try {
            await lck.promise();
        } catch (e) {
            throw new Error("failed to acquire the lock file for this project version");
        }
    }

    // Creating some version-specific metadata.
    let index_time = Date.now();
    let has_expiry = false;
    {
        let version_meta = {
            upload_time: (new Date(body.timestamp)).toISOString(),
            index_time: (new Date(index_time)).toISOString()
        };

        // Adding an expiry job and metadata, if we find an expiry file.
        let exp_info = await utils.getJson(s3, bucket_name, internal.expiry(project, version));
        has_expiry = (exp_info !== null);
        if (has_expiry) {
            let expired = index_time + exp_info.expires_in;
            version_meta.expiry_time = (new Date(expired)).toISOString();
            let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues", {
                method: "POST",
                body: JSON.stringify({ 
                    "title": "purge project", 
                    "body": JSON.stringify({ 
                        project: project,
                        version: version,
                        mode: "expiry",
                        delete_after: expired
                    })
                }),
                headers: { 
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + token
                } 
            });
            if (!res.ok) {
                throw new Error("failed to post an expiry job");
            }
            let payload = await res.json();
            version_meta.expiry_job_id = payload.number;
        }

        writes.push(utils.putJson(s3, bucket_name, internal.versionMetadata(project, version), version_meta));
    }

    // Listing all JSON files so we can pull them down in one big clump for each project.
    {
        let params = { Bucket: bucket_name, Prefix: project + "/" + version + "/" };

        let aggregated = [];
        while (1) {
            let listing = s3.listObjectsV2(params)
            let info = await listing.promise();

            for (const f of info.Contents) {
                if (f.Key.endsWith(".json")) {
                    aggregated.push(utils.getJson(s3, bucket_name, f.Key));
                }
            }

            if (info.IsTruncated) {
                params.ContinuationToken = info.NextContinuationToken;
            } else {
                break;
            }
        }

        let resolved = await Promise.all(aggregated);
        writes.push(utils.putJson(s3, bucket_name, internal.aggregated(project, version), resolved));
    }

    // Checking if permissions exist for the project; if not, we save them.
    {
        let overwrite = body.overwrite_permissions;
        let permpath = internal.permissions(project);

        if (!overwrite) {
            let res = s3.headObject({ Bucket: bucket_name, Key: permpath });
            try {
                await res.promise();
            } catch (e) {
                if (e.statusCode == 404) {
                    overwrite = true;
                } else {
                    throw e;
                }
            }
        }

        if (overwrite) {
            writes.push(utils.putJson(s3, bucket_name, permpath, body.permissions));
        }
    }

    // Checking if we are, indeed, the latest. 
    {
        async function fill_latest(l, v, i) {
            let relatest = false;
            let lat_info = await utils.getJson(s3, bucket_name, l);

            if (lat_info == null) {
                relatest = true;
            } else {
                if (typeof lat_info.index_time != "number") {
                    throw new Error("latest file should contain a 'index_time' number");
                }
                if (lat_info.index_time < i) {
                    relatest = true;
                }
            } 

            if (relatest) {
                writes.push(utils.putJson(s3, bucket_name, l, utils.formatLatest(v, i)));
            }
        }

        // If it's expirable, then we only write to '..latest' if no file is
        // present, and even then, it's just a placeholder. Any permanent
        // object takes precedence in the aliasing. 
        let latestpath = internal.latestPersistent(project);
        if (has_expiry) {
            await fill_latest(latestpath, "", -1);
        } else {
            await fill_latest(latestpath, version, index_time);
        }

        // For 'latest_all', we consider both transient and permanent objects.
        await fill_latest(internal.latestAll(project), version, index_time);
    }

    await Promise.all(writes);

    // Deleting the lock file.
    {
        let res = s3.deleteObject({ Bucket: bucket_name, Key: lockpath });
        await res.promise();
    }

    // Closing the issue once we're successfully done.
    await utils.closeIssue(repo_name, issue_number, token);

} catch (e) {
    // Commenting on the issue.
    console.error(e);
    let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues/" + issue_number + "/comments", { 
        method: "POST",
        body: JSON.stringify({ "body": e.message }),
        headers: { 
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        } 
    });
}

process.exitCode = 0;

