import { Random } from "./util.js";
export type Counts = [number, number, number]; // correction, neutral, harm; excludes the prior
export interface Experiment {
  key: string;
  triggerRate: number;
}
export class Posterior {
  readonly counts: Record<string, Counts> = {};
  observe(key: string, parent: 0 | 1, child: 0 | 1) {
    const counts = this.counts[key] ?? [0, 0, 0];
    counts[child > parent ? 0 : child < parent ? 2 : 1]++;
    this.counts[key] = counts;
  }
  alpha(key: string): Counts {
    return (this.counts[key] ?? [0, 0, 0]).map((n) => n + 1) as Counts;
  }
  observations(key: string) {
    return (this.counts[key] ?? []).reduce((a, b) => a + b, 0);
  }
}
const entropy = (p: number[]) =>
  -p.reduce((sum, n) => sum + (n > 0 ? n * Math.log(n) : 0), 0);
/** Importance reweight posterior worlds by the predictive outcome likelihood.
 * This estimates H(E*) - sum_o P(o) H(E*|o), using common MC worlds.
 * It avoids separately resampling every hypothetical posterior (and negative MC EIG).
 */
export function acquisition(
  experiments: Experiment[],
  posterior: Posterior,
  rng: Random,
  samples = 1000,
): number[] {
  if (!experiments.length) return [];
  if (experiments.length === 1) return [0];
  const n = experiments.length,
    joint = experiments.map(() =>
      Array.from({ length: 3 }, () => Array(n).fill(0) as number[]),
    ),
    winners = Array(n).fill(0) as number[];
  for (let m = 0; m < samples; m++) {
    const theta = experiments.map((e) => {
      const draws = posterior.alpha(e.key).map((a) => rng.gamma(a));
      const sum = draws.reduce((a, b) => a + b, 0);
      return draws.map((v) => v / sum);
    });
    const gains = theta.map(
      (p, i) => experiments[i].triggerRate * (p[0] - p[2]),
    );
    const best = Math.max(...gains),
      ties = gains.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0),
      winner = rng.pick(ties);
    winners[winner]++;
    for (let e = 0; e < n; e++)
      for (let o = 0; o < 3; o++) joint[e][o][winner] += theta[e][o] / samples;
  }
  const h = entropy(winners.map((v) => v / samples));
  return experiments.map((_, e) =>
    Math.max(
      0,
      h -
        joint[e].reduce((conditional, row) => {
          const probability = row.reduce((a, b) => a + b, 0);
          return (
            conditional + probability * entropy(row.map((v) => v / probability))
          );
        }, 0),
    ),
  );
}
