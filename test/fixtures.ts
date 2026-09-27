import type {
  ModelProvider,
  SampleInput,
  SampleOutput,
} from "@codesoul-co/ditto/worker/infer";
import { rootProfile, type AgentOutput } from "../src/types.js";

export const output = (
  answer: string,
  deficits: { id: string; text: string }[] = [],
  resolved: string[] = [],
): AgentOutput => ({
  candidate_answer: answer,
  claims: [],
  artifacts: [],
  open_deficits: deficits,
  resolved_deficits: resolved,
});
export function request(input: SampleInput): { kind: string; payload: any } {
  for (const message of input.messages) {
    if (typeof message.content !== "string") continue;
    try {
      const data = JSON.parse(message.content);
      if (data.kind && data.payload) return data;
    } catch {
      /* Other messages are instructions/context. */
    }
  }
  throw new Error("Test provider could not locate structured payload");
}
export class ScriptedProvider implements ModelProvider {
  inputs: SampleInput[] = [];
  constructor(
    private respond: (input: SampleInput) => unknown = (input) => {
      const { kind, payload } = request(input);
      if (kind === "factory")
        return {
          ...rootProfile,
          id: payload.id,
          objective: "Compute the missing arithmetic result.",
          capability: "Exact multiplication",
          private_context: "Use arithmetic evidence.",
          expected_output: "A numeric artifact",
          stop_condition: "Arithmetic evidence produced",
        };
      if (kind === "retrieve")
        return { agent_id: payload.candidates[0]?.id ?? null };
      if (kind === "mutation-selection") return { id: payload.edits[0].id };
      if (payload.profile.id !== "root")
        return {
          ...output("56"),
          artifacts: [
            {
              id: "product",
              type: "number",
              content: "56",
              deficit_refs: [payload.assigned.id],
            },
          ],
        };
      if (payload.incoming?.length) return output("56", [], ["root:d"]);
      return output("0", [
        { id: "d", text: "The product of 7 and 8 is missing." },
      ]);
    },
  ) {}
  async invoke(input: SampleInput): Promise<SampleOutput> {
    this.inputs.push(structuredClone(input));
    const value = this.respond(input);
    return {
      message: { role: "assistant", content: JSON.stringify(value) },
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    };
  }
}
