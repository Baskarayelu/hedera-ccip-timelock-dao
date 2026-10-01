.PHONY: compile format lint test

compile:
	forge compile

format:
	forge fmt && prettier --write "./scripts-js/**/*.js"

# Formatting is enforced; lint findings are reported. CI additionally runs `forge lint --deny warnings`
# with a pinned Foundry, so a newer local forge with new lints does not break `npm run lint`.
lint:
	forge fmt --check && forge lint && prettier --check "./scripts-js/**/*.js"

test:
	forge test
