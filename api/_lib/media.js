// Photos and videos live in Oracle Object Storage, reached through its S3-compatible API.
// Vercel Blob was outgrown: its free tier allows 1GB and 10GB of traffic a month, and a few
// phone videos being watched was enough to have the whole store cut off for 30 days.
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const { OCI_REGION, OCI_NAMESPACE, OCI_BUCKET, OCI_ACCESS_KEY_ID, OCI_SECRET_ACCESS_KEY } = process.env;

export const hasMedia = Boolean(OCI_REGION && OCI_NAMESPACE && OCI_BUCKET && OCI_ACCESS_KEY_ID && OCI_SECRET_ACCESS_KEY);
export const PREFIX = 'hai/';

// Anyone can read these (the bucket is public); only we can write, with the keys above.
export const publicUrl = (key) =>
  `https://objectstorage.${OCI_REGION}.oraclecloud.com/n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/${encodeURIComponent(key)}`;

// The file's name inside the bucket, taken back out of a stored URL.
export const keyFromUrl = (url) => {
  const m = /\/o\/([^?\s]+)/.exec(url) ?? /\/(hai\/[\w.-]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
};

let client;
function s3() {
  client ??= new S3Client({
    region: OCI_REGION,
    endpoint: `https://${OCI_NAMESPACE}.compat.objectstorage.${OCI_REGION}.oraclecloud.com`,
    credentials: { accessKeyId: OCI_ACCESS_KEY_ID, secretAccessKey: OCI_SECRET_ACCESS_KEY },
    forcePathStyle: true, // Oracle's S3 endpoint doesn't do bucket-as-subdomain
  });
  return client;
}

export async function putMedia(key, body, contentType) {
  await s3().send(new PutObjectCommand({
    Bucket: OCI_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable', // names are unique, so never re-fetch
  }));
  return publicUrl(key);
}

// A video is far too big for a function body (4.5MB) and Oracle's S3 endpoint won't accept the
// CORS settings that would let a browser send it to the store directly. So the browser cuts the
// file into pieces, posts each to this site, and the store puts them back together.
export const PART_SIZE = 4 * 1024 * 1024;

export async function startUpload(key, contentType) {
  const r = await s3().send(new CreateMultipartUploadCommand({
    Bucket: OCI_BUCKET, Key: key, ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return r.UploadId;
}

export async function uploadPart(key, uploadId, partNumber, body) {
  const r = await s3().send(new UploadPartCommand({
    Bucket: OCI_BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body,
  }));
  return r.ETag;
}

export async function finishUpload(key, uploadId, parts) {
  await s3().send(new CompleteMultipartUploadCommand({
    Bucket: OCI_BUCKET, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
  }));
  return publicUrl(key);
}

export async function abortUpload(key, uploadId) {
  await s3().send(new AbortMultipartUploadCommand({ Bucket: OCI_BUCKET, Key: key, UploadId: uploadId }));
}

export async function deleteMedia(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: OCI_BUCKET, Key: key }));
}

export async function listMedia() {
  const files = [];
  let token;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: OCI_BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      files.push({ pathname: o.Key, size: o.Size, uploadedAt: o.LastModified, url: publicUrl(o.Key) });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return files;
}
