/**
 * Messages between the Runtime and an Actor worker process.
 *
 * Kept in its own module so both sides compile against one definition — a
 * protocol drift between parent and child would show up as a run that silently
 * reports nothing rather than as a type error.
 */

export type ParentMessage =
    | {
          type: 'run';
          actorDir: string;
          actorName: string;
          runId: string;
          input: unknown;
          runtime?: import('./types.js').ActorRuntime;
      }
    /** Ask the Actor to stop at its next checkpoint before it is killed outright. */
    | { type: 'abort' };

export type ChildMessage =
    | { type: 'ready' }
    | { type: 'log'; message: string }
    /** Incremental, not cumulative: the parent adds these up. */
    | { type: 'items'; count: number }
    | { type: 'done' }
    | { type: 'error'; message: string };
