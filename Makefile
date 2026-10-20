# Test runner. The app itself has no build step.
#   make test         all suites
#   make test-js      Node unit tests
#   make test-browser headless Chromium tests (skipped if CHROME_BIN/chromium is missing)
#   make test-py      Python tool tests

.PHONY: test test-js test-browser test-py

test: test-js test-browser test-py

test-js:
	node --test tests/*.mjs

test-browser:
	@for f in tests/*.cjs; do echo "== $$f"; node "$$f" || exit 1; done

test-py:
	python3 -m unittest discover -s tests -p 'test_*.py'
