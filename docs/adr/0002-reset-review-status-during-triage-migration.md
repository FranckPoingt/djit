# Reset Review Status During Triage Migration

When replacing the old `unreviewed` / `reviewed` / `flagged` model with Triage Decisions, DJ-IT will reset existing track decisions instead of mapping old statuses forward. The old statuses do not reliably express whether the user still likes a track, so preserving them would pollute the new Curated Collection with ambiguous historical state.

Because DJ-IT is still a personal greenfield project, the code and schema should use the new domain term directly: `triage_decision`, not `review_status` with different labels.
