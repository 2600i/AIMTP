import json
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except Exception as exc:  # pragma: no cover
    raise SystemExit("Install jsonschema to run conformance tests: pip install jsonschema") from exc

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
VECTORS = ROOT / "tests" / "vectors"

with (SCHEMAS / "message.schema.json").open("r", encoding="utf-8") as f:
    MESSAGE_SCHEMA = json.load(f)

with (SCHEMAS / "envelope.schema.json").open("r", encoding="utf-8") as f:
    ENVELOPE_SCHEMA = json.load(f)

MESSAGE_VALIDATOR = Draft202012Validator(MESSAGE_SCHEMA)
ENVELOPE_VALIDATOR = Draft202012Validator(ENVELOPE_SCHEMA)


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate(path: Path, should_pass: bool) -> None:
    data = _load(path)
    errors = sorted(ENVELOPE_VALIDATOR.iter_errors(data), key=lambda e: e.path)
    if should_pass and errors:
        raise SystemExit(f"Expected valid but failed: {path.name} -> {errors[0].message}")
    if not should_pass and not errors:
        raise SystemExit(f"Expected invalid but passed: {path.name}")


def main() -> None:
    validate(VECTORS / "valid-envelope.json", should_pass=True)
    validate(VECTORS / "invalid-missing-spec.json", should_pass=False)
    validate(VECTORS / "invalid-bad-role.json", should_pass=False)
    print("OK: conformance vectors")


if __name__ == "__main__":
    main()
