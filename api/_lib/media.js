// Photos and videos live in Oracle Object Storage, reached through its S3-compatible API.
// Vercel Blob was outgrown: its free tier allows 1GB and 10GB of traffic a month, and a few
// phone videos being watched was enough to have the whole store cut off for 30 days.
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { OCI_REGION, OCI_NAMESPACE, OCI_BUCKET, OCI_ACCESS_KEY_ID, OCI_SECRET_ACCESS_KEY } = process.env;

export const hasMedia = Boolean(OCI_REGION && OCI_NAMESPACE && OCI_BUCKET && OCI_ACCESS_KEY_ID && OCI_SECRET_ACCESS_KEY);
export const PREFIX = 'hai/';

// Anyone can read these (the bucket is public); only we can write, with the keys above.
export const publicUrl = (key) =>
  `https://objectstorage.${OCI_REGION}.oraclecloud.com/n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/${encodeURIComponent(key)}`;

// Every URL this project has ever written, so old posts can be recognised and rewritten.
export const MEDIA_URL_RE = /https:\/\/[\w.-]*(?:blob\.vercel-storage\.com|oraclecloud\.com)\/[^\s)"'<]+/g;
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

// A video is far too big for a function body, so the browser sends it to the store itself with
// a URL that is signed for this one upload and expires shortly.
export async function signUpload(key, contentType, seconds = 3600) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: OCI_BUCKET, Key: key, ContentType: contentType }), { expiresIn: seconds });
}

// The browser can only send that upload if the store says its origin is welcome. Oracle's
// S3 endpoint is picky about this document, so a few shapes are tried from richest to plainest
// and the first one it accepts wins.
export async function allowOrigin(origin) {
  const shapes = [
    { AllowedOrigins: [origin], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
    { AllowedOrigins: [origin], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'] },
    { AllowedOrigins: [origin], AllowedMethods: ['PUT', 'GET'] },
    { AllowedOrigins: ['*'], AllowedMethods: ['PUT', 'GET'] },
  ];
  const tried = [];
  for (const rule of shapes) {
    try {
      await s3().send(new PutBucketCorsCommand({ Bucket: OCI_BUCKET, CORSConfiguration: { CORSRules: [rule] } }));
      return { ok: true, rule, tried };
    } catch (err) {
      tried.push({ rule: Object.keys(rule).join('+'), error: err.message });
    }
  }
  return { ok: false, tried };
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
