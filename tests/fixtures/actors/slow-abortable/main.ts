import type { ActorContext } from '../../../../src/types.js';
/** Well-behaved: checks the signal, so it stops during the grace period. */
export async function run(_input: unknown, ctx: ActorContext): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (ctx.signal.aborted) {
            ctx.log('noticed the abort and stopped cleanly');
            return;
        }
        await ctx.pushData({ i });
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
