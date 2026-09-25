import { createHash } from "node:crypto";

// npm run hash-key -- <api-key>   prints the sha256 to paste into config/tenants.yaml
const key = process.argv[2];
if (!key) {
  console.error("usage: npm run hash-key -- <api-key>");
  process.exit(1);
}
console.log(createHash("sha256").update(key).digest("hex"));
