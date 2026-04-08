const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
  ".csv": "text/csv; charset=utf-8",
};

const server = http.createServer((request, response) => {
  try {
    if (request.method === "OPTIONS") {
      writeCommonHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      writeCommonHeaders(response);
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method Not Allowed");
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === "/") {
      pathname = "/index.html";
    }

    const resolvedPath = resolveSafePath(pathname);
    if (!resolvedPath) {
      writeCommonHeaders(response);
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    let filePath = resolvedPath;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      writeCommonHeaders(response);
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }

    const stat = fs.statSync(filePath);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const rangeHeader = request.headers.range;

    writeCommonHeaders(response);

    if (rangeHeader) {
      const parsedRange = parseRange(rangeHeader, stat.size);
      if (!parsedRange) {
        response.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Requested Range Not Satisfiable");
        return;
      }

      const { start, end } = parsedRange;
      const chunkSize = end - start + 1;
      response.writeHead(206, {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": chunkSize,
        "Cache-Control": "no-cache",
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      fs.createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    console.error(error);
    writeCommonHeaders(response);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Range-capable static server running at http://127.0.0.1:${PORT}`);
  console.log(`Serving ${ROOT}`);
});

function writeCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
}

function resolveSafePath(pathname) {
  const normalizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const resolvedPath = path.resolve(ROOT, `.${normalizedPath}`);
  if (!resolvedPath.startsWith(ROOT)) {
    return null;
  }
  return resolvedPath;
}

function parseRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start == null && end == null) {
    return null;
  }

  if (start == null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
      return null;
    }
    if (end == null) {
      end = fileSize - 1;
    }
  }

  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  end = Math.min(end, fileSize - 1);
  return { start, end };
}
