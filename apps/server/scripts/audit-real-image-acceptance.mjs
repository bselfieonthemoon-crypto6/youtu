// Read-only postflight; never generates or retries an image.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { imageSubmissionReceipt } from "../src/features/jobs/image-submission-receipt.js";

assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421");
const file = process.argv.find(arg => arg.startsWith("--fixture="))?.slice(10);
assert(file, "--fixture=<prepared local manifest> required");
const fixture = JSON.parse(await readFile(file, "utf8"));
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const rows = await admin.from("background_jobs").select("id,status,payload,result,credits_cost,canvas_id")
  .eq("session_id", fixture.fixture.sessionId).eq("workspace_id", fixture.workspaceId).eq("job_type", "image_generation");
assert.ifError(rows.error); assert.equal(rows.data?.length, 1, "Exactly one image job must exist; zero is not an E2E pass");
const job = rows.data[0];
assert.equal(job.status, "succeeded");
assert.equal(job.payload.quality, "standard"); assert.equal(job.payload.resolution, "1k");
assert.equal(job.canvas_id, fixture.fixture.canvasId);
assert(job.result?.canvas_element_id && job.result?.asset_id && job.result?.chat_finalized_at,
  "Provider result must have both canvas and chat delivery receipts");
const canvas = await admin.from("canvases").select("content").eq("id", job.canvas_id).single();
assert.ifError(canvas.error);
const element = canvas.data.content.elements.find(element => element.id === job.result.canvas_element_id && !element.isDeleted);
assert(element, "Finalized image element must exist in the actual canvas");
const messages = await admin.from("chat_messages").select("content_blocks").eq("session_id", fixture.fixture.sessionId);
assert.ifError(messages.error);
const cards = messages.data.flatMap(row => row.content_blocks ?? []).filter(block => block.output?.jobId === job.id);
const card = cards.find(block => block.output.status === "succeeded");
assert(card, "Succeeded image card must exist in the persisted conversation");
const receipt = imageSubmissionReceipt(job);
assert.equal(receipt.creditsCost, job.credits_cost ?? 0);
for (const [key, value] of Object.entries(receipt)) assert.deepEqual(card.output[key], value);
const ledger = await admin.from("credit_transactions").select("transaction_type,amount")
  .eq("job_id", job.id).eq("workspace_id", fixture.workspaceId);
assert.ifError(ledger.error);
const deductions = ledger.data.filter(row => row.transaction_type === "generation_deduct");
assert(deductions.length <= 1, "No duplicate local credit deduction is permitted");
const deducted = deductions.reduce((sum, row) => sum - row.amount, 0);
assert.equal(deducted, job.credits_cost ?? 0, "Persisted cost must match actual local deduction ledger");
const report = { createdAt: new Date().toISOString(), kind: "read_only_real_image_postflight",
  jobId: job.id, status: job.status, canvasElementId: element.id, assetId: job.result.asset_id,
  quality: job.payload.quality, resolution: job.payload.resolution, submissionReceipt: receipt,
  databaseDeliveryVerified: true, localCreditLedgerVerified: true, localCreditsDeducted: deducted,
  browserVisualVerified: false,
  note: "Browser render and provider-attempt/external-money audit require separate evidence; this script does not claim them." };
const output = `${file}.postflight.json`;
await writeFile(output, JSON.stringify(report, null, 2));
console.log(`Database postflight passed: ${output}`);
