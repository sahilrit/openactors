import type { ActorContext } from '../../../../src/types.js';
/** Exits without reporting — the shape of a segfault or a stray process.exit(). */
export async function run(_input: unknown, ctx: ActorContext): Promise<void> {
    await ctx.pushData({ before: 'the crash' });
    process.exit(3);
}
