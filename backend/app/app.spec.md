# app

The agent, its tools, and the HTTP surface. Every image passes through `image_processing` and is addressed by an immutable 12-hex id; only `prepare_for_slack` may mint the artifact the user downloads as an emoji.

## works when

- boundary "every emoji leaving the service is a PNG no larger than 128x128 and under 128KB" at prepare_for_slack via test "test_slack_boundary_holds_for_every_admitted_format"
- passes test "test_prepare_for_slack_fits_dimensions"
- passes test "test_prepare_for_slack_pads_non_square_to_square"
- passes test "test_prepare_for_slack_returns_new_immutable_id"
- passes test "test_get_image_path_unknown_id_is_none"
- main.py imports app.agent
- agent.py imports app.image_processing

## invariants

- every emoji leaving the service is a PNG no larger than 128x128 and under 128KB

## why

Image ids are immutable by convention (each of download / text / crop / slack-ready mints a fresh 12-hex id and never overwrites its source) — that is a tier-3 convention today, anchored only by `test_prepare_for_slack_returns_new_immutable_id`, and a candidate for promotion to a single `_new_id` chokepoint.

Slack rejects custom emoji that exceed 128KB or 128px, and a user who downloads a broken emoji gets no error from us — so the limit is enforced in code with a fallback ladder (optimize → quantize → shrink) and tested with incompressible noise, the worst case for PNG.

## refutations

- every emoji leaving the service is a PNG no larger than 128x128 and under 128KB: removed the thumbnail AND the canvas-paste in prepare_for_slack -> RED, boundary + 2 passes-test claims failed by name (png/jpg/gif all). Note: removing only one of the two stays green — they independently cap dimensions — and disabling the quantize/shrink fallback ladder also stays green (see conjecture in the journal).
