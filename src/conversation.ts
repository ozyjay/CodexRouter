import { CodexAppServer } from "./appServer";
import { AllocationSelection } from "./contracts";
type ConversationServer = Pick<CodexAppServer, "startTurn" | "generation">;

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

/** Sidebar-owned thread; never shared with standalone command tasks or another workspace. */
export class SidebarConversation {
  private current?: { server: ConversationServer; generation: number; cwd: string; threadId: string };
  private readonly messages: ConversationMessage[] = [];
  private revision = 0;

  get hasContext(): boolean { return this.current !== undefined; }

  reset(): void {
    this.current = undefined;
    this.messages.length = 0;
    this.revision++;
  }

  beginTurn(task: string): void {
    this.messages.push({ role: "user", text: task }, { role: "assistant", text: "Checking Codex…" });
  }

  replaceAssistant(text: string): void {
    const message = this.messages.at(-1);
    if (!message || message.role !== "assistant") throw new Error("No active assistant message is available.");
    message.text = text;
  }

  appendAssistant(text: string): void {
    const message = this.messages.at(-1);
    if (!message || message.role !== "assistant") throw new Error("No active assistant message is available.");
    message.text += text;
  }

  history(): ConversationMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  async startTurn(server: ConversationServer, prompt: string, cwd: string, selection: AllocationSelection): Promise<{ threadId: string; turnId: string }> {
    const previous = this.current;
    if (previous && (previous.server !== server || previous.generation !== server.generation || previous.cwd !== cwd)) {
      throw new Error("The conversation belongs to a previous Codex process or workspace. Choose New conversation before continuing.");
    }
    const revision = this.revision;
    const turn = await server.startTurn(prompt, cwd, selection.model, selection.effort, previous?.threadId);
    if (revision === this.revision) this.current = { server, generation: server.generation, cwd, threadId: turn.threadId };
    return turn;
  }
}
