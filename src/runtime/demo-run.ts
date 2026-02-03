import { runInMemoryTaskDemo } from "./demo";

async function main() {
  const { requestEnvelope, responseEnvelope } = await runInMemoryTaskDemo(console);

  console.log("Request envelope:");
  console.log(JSON.stringify(requestEnvelope, null, 2));
  console.log("Response envelope:");
  console.log(JSON.stringify(responseEnvelope, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
