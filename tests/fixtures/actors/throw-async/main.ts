import type { ActorContext } from '../../../../src/types.js';
/** Throws from a callback the Actor's own promise chain cannot catch. */
export async function run(_input: unknown, _ctx: ActorContext): Promise<void> {
    setTimeout(() => {
        throw new Error('exploded in a stray callback');
    }, 20);
    await new Promise((resolve) => setTimeout(resolve, 5000));
}
