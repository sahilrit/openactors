import type { ActorContext } from '../../../../src/types.js';
/**
 * The case that settles the design: a synchronous loop never yields, so no
 * AbortController, timer or promise rejection can interrupt it. Only killing
 * the process works.
 */
export async function run(_input: unknown, ctx: ActorContext): Promise<void> {
    ctx.log('entering an uninterruptible loop');
    // eslint-disable-next-line no-constant-condition
    while (true) {
        Math.sqrt(Math.random());
    }
}
