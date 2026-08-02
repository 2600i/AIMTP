"""Cross-language schema conformance check for AIMTP v0.1.

Validates every envelope vector in tests/vectors through a Python JSON Schema
implementation, so schema rules that only hold because of an Ajv quirk are
caught. Companion to the Node runner (tests/conformance/run.mjs), which is the
authoritative kit.

    pip install jsonschema
    python3 tests/conformance/validate_schemas.py

Vectors follow the same naming convention as the Node runner: files starting
with "valid-" must validate, files starting with "invalid-" must not.
"""

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Install jsonschema to run conformance tests: pip install jsonschema"
    ) from exc

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
VECTORS = ROOT / "tests" / "vectors"

SPEC_VERSION = "aimtp/0.1"


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


MESSAGE_SCHEMA = _load(SCHEMAS / "message.schema.json")
ENVELOPE_SCHEMA = _load(SCHEMAS / "envelope.schema.json")

# envelope.schema.json refs "message.schema.json" relatively, which resolves
# against the envelope $id. Register the message schema under both its absolute
# $id and the relative name so either resolution path works.
_message_resource = Resource.from_contents(
    MESSAGE_SCHEMA, default_specification=DRAFT202012
)
REGISTRY = Registry().with_resources(
    [
        (MESSAGE_SCHEMA.get("$id", "message.schema.json"), _message_resource),
        ("message.schema.json", _message_resource),
        (
            ENVELOPE_SCHEMA.get("$id", "envelope.schema.json"),
            Resource.from_contents(ENVELOPE_SCHEMA, default_specification=DRAFT202012),
        ),
    ]
)

ENVELOPE_VALIDATOR = Draft202012Validator(ENVELOPE_SCHEMA, registry=REGISTRY)


def check(path: Path) -> list:
    """Return a list of failure strings for one vector."""
    name = path.name
    if name.startswith("valid-"):
        should_pass = True
    elif name.startswith("invalid-"):
        should_pass = False
    else:
        return [f"{name}: vector name must start with 'valid-' or 'invalid-'"]

    try:
        data = _load(path)
    except json.JSONDecodeError as exc:
        return [f"{name}: unparseable JSON: {exc}"]

    failures = []
    errors = sorted(ENVELOPE_VALIDATOR.iter_errors(data), key=lambda e: list(e.path))

    if should_pass and errors:
        failures.append(f"{name}: expected valid but failed: {errors[0].message}")
    elif not should_pass and not errors:
        failures.append(f"{name}: expected invalid but it validated")

    # Every valid vector must declare the frozen wire version.
    if should_pass and not errors and data.get("spec") != SPEC_VERSION:
        failures.append(
            f'{name}: spec must be "{SPEC_VERSION}", got "{data.get("spec")}"'
        )

    return failures


def main() -> None:
    paths = sorted(VECTORS.glob("*.json"))
    if not paths:
        raise SystemExit(f"No vectors found in {VECTORS}")

    failures = []
    for path in paths:
        failures.extend(check(path))

    if failures:
        print("FAILED: conformance vectors", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        raise SystemExit(1)

    print(f"OK: conformance vectors ({len(paths)} checked)")


if __name__ == "__main__":
    main()
