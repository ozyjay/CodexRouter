import { CodexAppServer } from "./appServer";
import { AllocationSelection } from "./contracts";
type ConversationServer = Pick<CodexAppServer, "startTurn" | "generation">;

/** Sidebar-owned thread; never shared with standalone command tasks or another workspace. */
export class SidebarConversation {
  private current?: { server: ConversationServer; generation: number; cwd: string; threadId: string };
  private revision = 0;

  get hasContext(): boolean { return this.current !== undefined; }

  reset(): void {
    this.current = undefined;
    this.revision++;
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
