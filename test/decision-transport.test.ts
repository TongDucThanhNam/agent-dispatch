import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareDecisionInvocation } from "../src/decision-codex";
import { execute } from "../src/process";
import { codex, save, projectRoot, node } from "../src/paths";

test("installed Codex CLI sends a fresh read-only structured decision to a local mock, without paid inference", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dispatch-codex-transport-"),
  );
  const prompt = JSON.stringify({
    packetHash: "fixture-only",
    authority: { objective: "Bounded fixture decision" },
    evidence: { status: "needs_replan" },
  });
  const output = {
    packetHash: "fixture-only",
    action: "needs_user",
    taskId: null,
    reason: "Fixture decision",
    guidance: "",
  };
  const text = JSON.stringify(output);
  const message = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const requests: any[] = [];
  let credentialReceived = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.has("authorization")) credentialReceived = true;
      if (req.method === "GET") return Response.json({ models: [] });
      requests.push(await req.json());
      const events = [
        {
          type: "response.created",
          response: {
            id: "resp_fixture",
            object: "response",
            status: "in_progress",
            output: [],
          },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: "resp_fixture",
            object: "response",
            status: "completed",
            output: [message],
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
      ];
      return new Response(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const args = prepareDecisionInvocation(directory, prompt);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args).not.toContain("resume");
    expect(args).not.toContain("--thread");
    args.splice(
      args.length - 1,
      0,
      "-c",
      'model_provider="fixture"',
      "-c",
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false}`,
    );
    const env = { ...process.env };
    for (const key of [
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "CODEX_APP_TOOLS_PIPE_PATH",
      "CODEX_PERMISSION_PROFILE",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ])
      delete env[key];
    const result = await execute([codex, ...args], {
      cwd: directory,
      input: prompt,
      env,
      timeoutMs: 30000,
    });
    expect(result.ok).toBe(true);
    expect(credentialReceived).toBe(false);
    expect(requests).toHaveLength(1);
    const request = requests[0],
      input = JSON.stringify(request.input);
    expect(request.model).toBe("gpt-6-astra");
    expect(input).toContain("Bounded fixture decision");
    if (process.env.CODEX_THREAD_ID)
      expect(input).not.toContain(process.env.CODEX_THREAD_ID);
    expect(Buffer.byteLength(input)).toBeLessThan(64000);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(directory, "response.json"), "utf8"),
      ),
    ).toEqual(output);
    save(path.join(projectRoot, "docs/decision-transport-verification.json"), {
      measuredAt: new Date().toISOString(),
      backend: "loopback Responses mock; no paid model inference",
      modelRequested: request.model,
      modelRequests: requests.length,
      authorizationReceived: credentialReceived,
      fixturePacketBytes: Buffer.byteLength(prompt),
      actualRequestInputBytes: Buffer.byteLength(input),
      inheritedOriginalConversation: false,
      advertisedToolGroups: request.input
        .filter((i: any) => i.type === "additional_tools")
        .flatMap((i: any) => i.tools.map((t: any) => t.name)),
      note: "Mock usage values are synthetic and are not savings evidence. Fixed CLI tool/instruction overhead remains. Real production quality, routing and token usage require a real assigned task.",
    });
  } finally {
    server.stop(true);
    const resolved = fs.realpathSync(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith("dispatch-codex-transport-")
    )
      throw Error("Unsafe cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}, 40000);

test("stream guard stops a tool-using decision before a later action", async () => {
  const result = await execute(
    [
      node,
      "-e",
      "console.log(JSON.stringify({item:{type:'command_execution'}}));setTimeout(()=>console.log('late-action'),3000)",
    ],
    {
      timeoutMs: 10000,
      onStdoutLine: (line) =>
        JSON.parse(line).item?.type === "command_execution" ? false : undefined,
    },
  );
  expect(result.ok).toBe(false);
  expect(result.stdout).not.toContain("late-action");
});
