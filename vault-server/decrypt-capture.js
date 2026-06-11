const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node vault-server/decrypt-capture.js vault-data/captures/<id>.json.enc");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const keyPath = path.join(root, "vault-data", ".vault-key");
const key = Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
const payload = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
const plaintext = Buffer.concat([
  decipher.update(Buffer.from(payload.data, "base64")),
  decipher.final()
]);

process.stdout.write(JSON.stringify(JSON.parse(plaintext.toString("utf8")), null, 2));
