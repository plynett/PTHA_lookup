# Deploy on GitHub Pages + Backblaze B2

This is the simplest production-style setup for the current app:

- GitHub Pages hosts the frontend:
  - `index.html`
  - `app.js`
  - `styles.css`
  - `metadata/index.json`
  - `metadata/*_manifest.json`
- Backblaze B2 hosts the large binary lookup files:
  - `data_factored/grids/*_lookup.bin`

## 1. Create the B2 bucket

Create a new B2 bucket with:

- Bucket type: `allPublic`
- Suggested name: `ptha-lookup-data`

Backblaze's public file URLs use the pattern:

```text
https://fNNN.backblazeb2.com/file/<bucket-name>/<path-inside-bucket>
```

Example from the Backblaze docs:

```text
https://f001.backblazeb2.com/file/cute_pictures/cats/kitten.jpg
```

For this project, the data root should look like:

```text
https://fNNN.backblazeb2.com/file/ptha-lookup-data/data_factored
```

## 2. Upload the binary dataset

Upload the `.bin` lookup files from the local `data_factored/grids/...` tree to the bucket,
preserving the grid folder structure.

Expected object layout inside the bucket:

```text
data_factored/grids/01_Crescent_City/01_Crescent_City_lookup.bin
...
```

The bucket can keep the already-uploaded metadata files with the same bucket name if you want.
The app simply will not use them once metadata is served locally from GitHub Pages.

## 3. Configure B2 CORS

The app makes cross-origin `GET` requests with a single `Range` header and reads the
`Content-Range` response header.

Recommended B2 CORS rule:

```json
[
  {
    "corsRuleName": "githubPagesRangeLookup",
    "allowedOrigins": [
      "https://YOUR-GITHUB-USER.github.io"
    ],
    "allowedHeaders": [
      "range"
    ],
    "allowedOperations": [
      "b2_download_file_by_name",
      "b2_download_file_by_id"
    ],
    "exposeHeaders": [
      "Content-Range",
      "Content-Length",
      "Accept-Ranges",
      "Content-Type",
      "x-bz-content-sha1"
    ],
    "maxAgeSeconds": 3600
  }
]
```

Replace `https://YOUR-GITHUB-USER.github.io` with your real Pages origin.

If you later use a custom domain for the frontend, replace the origin with that domain.

## 4. Point the app at B2 for binaries only

The app now supports separate roots for metadata and binaries through either:

- a global `window.PTHA_BINARY_BASE_URL`
- or a `?binaryBaseUrl=` URL parameter

For backward compatibility, the older shared:

- `window.PTHA_DATA_BASE_URL`
- `?dataBaseUrl=`

still works and applies to both metadata and binaries.

The cleanest option for GitHub Pages is to add this inline script in `index.html`
immediately before the `app.js` script tag:

```html
<script>
  window.PTHA_BINARY_BASE_URL = "https://fNNN.backblazeb2.com/file/ptha-lookup-data/data_factored";
</script>
```

Metadata defaults to the local GitHub Pages path:

```text
./metadata
```

So `index.json` and the grid manifests should be published on Pages under:

```text
metadata/index.json
metadata/01_Crescent_City_manifest.json
...
```

If you do not want to edit the page yet, you can also test with:

```text
https://YOUR-GITHUB-USER.github.io/YOUR-REPO/?binaryBaseUrl=https://fNNN.backblazeb2.com/file/ptha-lookup-data/data_factored
```

## 5. Publish the frontend on GitHub Pages

Publish the repo with the normal GitHub Pages flow.

The published site should include:

- the frontend files
- `metadata/index.json`
- `metadata/*_manifest.json`

The published site should not include the `.bin` lookup files.

## 6. Verify the deployment

Check these in the browser dev tools:

- `index.json` loads from the GitHub Pages URL
- manifest files load from the GitHub Pages URL
- binary requests return `206 Partial Content`
- binary requests load from the B2 URL
- `Content-Range` is visible in the response headers

## Notes

- The app is efficient with this setup because each click fetches only a tiny byte range from
  a `.bin` file, not the whole file.
- Performance will be driven mostly by network latency, not payload size.
- Do not add any proxy or CDN feature that compresses or transforms the `.bin` files.
  The byte offsets must match the raw stored bytes exactly.
