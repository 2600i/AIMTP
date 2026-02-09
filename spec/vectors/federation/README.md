# Federation Conformance Vectors

This directory contains Phase 7 federation vector placeholders.

## Files

- `descriptor-valid.json`: descriptor and trust entry expected to verify.
- `descriptor-invalid-signature.json`: descriptor expected to fail signature verification.

## Expected usage

Implementations SHOULD load each vector and compare actual verification result to `expected`.
