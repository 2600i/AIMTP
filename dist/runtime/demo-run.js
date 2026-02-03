"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const demo_1 = require("./demo");
async function main() {
    const { requestEnvelope, responseEnvelope } = await (0, demo_1.runInMemoryTaskDemo)(console);
    console.log("Request envelope:");
    console.log(JSON.stringify(requestEnvelope, null, 2));
    console.log("Response envelope:");
    console.log(JSON.stringify(responseEnvelope, null, 2));
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
