# Factorized public acceptance fixtures

Synthetic, hand-authored acceptance records for the work-event gold contract.
Ten records per revision; every record must satisfy `validateFactorizedGold`,
which `gold-contract.test.ts` enforces on all three revisions.

These are the only research artifacts kept under version control. `research/`
itself is untracked: it holds model weights, exported private LINE corpora, and
the training/experiment scripts. Public fixtures live here so the contract test
runs on a fresh clone without any of that.