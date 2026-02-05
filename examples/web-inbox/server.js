"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number.parseInt(process.env.PORT || "8080", 10);
const root = __dirname;

function send(res, status, contentType, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    send(res, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "text/plain; charset=utf-8", "Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    send(res, 200, contentType, data);
  });
});

server.listen(port, () => {
  console.log(`AIMTP web demo available at http://localhost:${port}`);
});
