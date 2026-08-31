# Partition Bound Parser Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make PR #7005's coverage check handle the production partition topology without reactivating startup DDL when PostgreSQL returns an unsupported bound shape.

**Architecture:** Keep PostgreSQL responsible for deparsing and casting partition timestamps, but replace quote-position parsing with one anchored expression that captures lower and upper tokens independently. Return both coverage and parser-recognition state so unrecognized catalog output fails closed before DDL.

**Tech Stack:** Rust, SQLx, PostgreSQL 17 catalog functions, Tokio integration tests, GitHub Actions.

---

### Task 1: Reproduce production bounds

**Files:**
- Modify: `crates/buzz-db/src/store/partition.rs`

1. Add `MINVALUE` past partitions to the shared PostgreSQL fixture.
2. Add coverage for successful missing-partition creation, `DEFAULT`, and unsupported multi-column bounds.
3. Run the focused PostgreSQL tests and confirm they fail against the positional parser.

### Task 2: Replace positional parsing

**Files:**
- Modify: `crates/buzz-db/src/store/partition.rs`

1. Extract the complete lower and upper tokens with an anchored regular expression.
2. Map `MINVALUE` and `MAXVALUE` to timestamp infinities and cast finite values.
3. Treat `DEFAULT` as routing coverage.
4. Return `InvalidData` if any leaf bound is neither `DEFAULT` nor the supported one-column range form.
5. Run the focused PostgreSQL tests and confirm they pass.

### Task 3: Wire and verify CI coverage

**Files:**
- Modify: `.github/workflows/ci.yml`

1. Add the new ignored PostgreSQL tests to the Backend Integration selector.
2. Run formatting, focused tests, `buzz-db` tests, clippy, and workflow lint.
3. Transfer the verified patch locally, commit, push the existing branch, and monitor PR #7005.

### Task 4: Address independent review findings

**Files:**
- Modify: `crates/buzz-db/src/store/partition.rs`
- Modify: `.github/workflows/ci.yml`

1. Reproduce session-local DDL bounds, partial-overlap acceptance, and nested-default false coverage.
2. Set transaction-local UTC for DDL, re-check coverage after `42P17`, and reject nested topologies.
3. Add all three regressions to Backend Integration CI and repeat the full verification matrix.
