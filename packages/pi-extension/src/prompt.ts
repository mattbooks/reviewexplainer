import type { ReviewFile } from "@reviewexplainer/format";

export function reviewPrompt(review: ReviewFile, opts: { findings?: boolean } = {}): string {
  const head = review.subject.head.sha;
  const pr = review.subject.pr;
  const findings = opts.findings ?? true;
  return [
    `You are preparing a guided code review for ${pr ? `PR #${pr.number} "${pr.title}"` : `the change ${review.subject.base.ref ?? review.subject.base.sha.slice(0, 12)}..${review.subject.head.ref ?? head.slice(0, 12)}`}.`,
    "A reviewer will read the diff in the order you choose, with your explanations beside the code. Work only through the review_* tools; do not edit any files.",
    "",
    "Pass 1: reading order.",
    "1. Call review_files, then review_show_hunk for the files you need. Read surrounding code with read or bash when a hunk is unclear. The working tree may not be at the head commit, so read head versions with `git show " +
      head.slice(0, 12) +
      ":<path>`.",
    "2. Group the hunks into 3-10 steps that each tell one part of the story. Order them so every step only depends on earlier ones: data shapes and interfaces first, then the core behavior, then callers and wiring, then tests, then docs, config and generated files.",
    "3. Put a hunk with the code it belongs to, even if that splits a file across steps. If one hunk over about 40 rows mixes unrelated changes, split it with slices (row ranges from review_show_hunk) that together cover all its rows.",
    "4. Give each step a short title and a 2-4 sentence narrative: what changed, why, and what to check. Then call review_set_steps. Every hunk must appear exactly once; fix any problems it reports.",
    "5. Call review_overview with 3-6 sentences on what the change does, how the steps fit together and where the risk is.",
    "6. Add review_annotate notes only where code is non-obvious and the narrative does not already explain it (at most about one per step).",
    findings ? "" : undefined,
    findings ? "Pass 2: findings." : undefined,
    findings
      ? "7. Look for bugs, security problems, data loss, concurrency issues, broken error handling, API breaks and missing tests. Call review_comment for each real issue, anchored to exact lines from review_show_hunk (side old for deleted lines). Use severity honestly and skip pure style preferences. Add a suggestion only when you are confident in the exact replacement."
      : undefined,
    "",
    "Finish with a two-sentence summary of the guide and the most important findings.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}
