//! Compile-fail evidence: the relay NIP-FI authority boundary is
//! compiler-enforced.  Each fixture must fail to compile; trybuild records the
//! actual rustc error as a `.stderr` snapshot.

#[test]
fn seal_boundary_compile_fail() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}
