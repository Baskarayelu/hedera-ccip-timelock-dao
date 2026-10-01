.PHONY: compile format lint test

compile:
	forge compile

format:
	forge fmt && prettier --write "./scripts-js/**/*.js"

lint:
	forge fmt --check && forge lint --deny warnings && prettier --check "./scripts-js/**/*.js"

test:
	forge test
