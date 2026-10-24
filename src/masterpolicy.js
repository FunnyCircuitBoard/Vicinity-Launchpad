/**
 * The Citycoin.dev master policy (MASTER CHANGE ORDER V5, 23 Oct 2026) as one deeply frozen object, plus pure helpers.
 *
 * DESIGN, NOT LIVE. No module of the Worker imports this file yet (test/masterpolicy.test.js checks that), so it changes nothing
 * on the live site: the bundler never reaches it from src/index.js. The same document is docs/citycoin-master/policy.json, and the
 * test keeps the two identical. Approval of a policy is not evidence of deployment (master section 16, Configuration acceptance):
 * live status comes from deployment and chain state only.
 *
 * Exports:
 *   MASTER_POLICY, POLICY_VERSION       the frozen document (policy values, the default deployment block, master sections,
 *                                       code-verification notes)
 *   validatePolicy(policy)              { ok, errors: [{ code, path, message }] }: rejects any drift from the master values,
 *                                       broken internal arithmetic, incompatible switches and missing deployment inputs
 *   assertValidPolicy(policy)           the same, throwing a PolicyError that carries `errors`
 *   withDeployment(policy, overrides)   an unfrozen copy with deployment.environment / fixture / flags / inputs overridden
 *   selectionEpoch(unixSeconds)         floor(unix_seconds / 21600)
 *   selectionBoundary(epoch)            epoch * 21600 (Unix seconds; always 00:00, 06:00, 12:00 or 18:00 UTC)
 *   nextSelectionBoundary(unixSeconds)  the first boundary strictly after unixSeconds
 *   tradeFeeSplit(quoteBasis)           the 250 bps fee and its five buckets, BigInt, exact flooring (bucket sum = total)
 *   activityTotals(events)              activity points with category caps and UTC daily limits
 *   mainTokenConfig(env)                amendment 01: the main-token mint from MAIN_TOKEN_MINT, or null when unset, malformed or a
 *                                       legacy mint (with the reason in `problem`)
 *   officialLinks(env)                  amendment 01: the official X and Telegram links from OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL,
 *                                       normalized, or null when unset or refused (with the reason in `problems`)
 *   validateDeploymentConfig(env, features)  amendment 01: { ok, errors } for those three keys, given the enabled features that
 *                                       need the main token (MAIN_TOKEN_FEATURES)
 *
 * The shape checks here are not verification: a mint or link is verified by the procedure in
 * docs/citycoin-master/amendment-01-new-main-token.md before anyone writes it into the configuration.
 *
 * Rule for this file: no console call, no dynamic import, and no fee literal written as a percentage (tests scan every src file).
 */

const DOCUMENT = {
  "document": "Citycoin.dev master policy",
  "policy_version": "citycoin-master-v5",
  "owner_delegation_date": "2026-10-23",
  "status": {
    "policy": "approved_target",
    "deployment": "not_deployed",
    "statement": "DESIGN. These are the approved target values of MASTER CHANGE ORDER V5 (23 Oct 2026). Approval of this policy is not evidence that anything is built, deployed, audited or active: live status comes only from deployment and chain state (master section 16, Configuration acceptance). No module of the live site reads this file or src/masterpolicy.js yet. Owner amendment 01 (24 Oct 2026) replaces the fixed main-token mint with a centrally configured main token: an owner-supplied mint (MAIN_TOKEN_MINT) that is verified on chain before use and stays null until then. The old $VICINITY mint is a legacy token, history only.",
    "baseline": "live site main 4aa408e; draft program vicinity_curve ec148c2 (not deployed anywhere public)",
    "prepared": "2026-10-24"
  },
  "amendments": [
    {
      "id": "amendment-01",
      "date": "2026-10-24",
      "source": "owner instruction; its verbatim intent is recorded in docs/citycoin-master/amendment-01-new-main-token.md",
      "summary": "A new main token with a new Solana mint, a new official X page and a new official Telegram handle, each supplied by the owner, verified, and configured in one place (MAIN_TOKEN_MINT, OFFICIAL_X_URL, OFFICIAL_TELEGRAM_URL). The old $VICINITY mint becomes a legacy token, history only. No automatic swap, migration, airdrop or transfer of anyone's holdings.",
      "overrides": "master sections 02, 07, 14, 16 and 28 where they keep the existing main-token mint or forbid a replacement main-token mint; for the main token only",
      "values_supplied": false
    }
  ],
  "policy": {
    "pairs_and_branding": {
      "product_name": "Citycoin.dev",
      "canonical_origin": "https://citycoin.dev",
      "legacy_origin": "https://vicinity.city",
      "main_token_label": "Main token",
      "trading_venue": "custom_curve_and_internal_pool",
      "external_venue_for_new_path": false,
      "quote_assets": [
        "SOL",
        "USDC",
        "approved_additional_classic_spl"
      ]
    },
    "main_token": {
      "mint": null,
      "config_key": "MAIN_TOKEN_MINT",
      "source": "owner-supplied, verified on chain before use",
      "replacement_authorized": true,
      "replacement_authority": "owner amendment 01 (2026-10-24)",
      "required_checks": [
        "mint_account_exists",
        "owner_program_is_classic_spl_token_or_a_documented_supported_program",
        "decimals",
        "total_supply",
        "mint_authority",
        "freeze_authority",
        "metadata_name_and_symbol_read_from_chain",
        "not_equal_to_any_legacy_mint"
      ],
      "supported_token_programs": [
        "classic_spl_token"
      ],
      "other_token_programs": "refused until a reviewed policy change documents and tests them",
      "verification_record": [
        "mint",
        "cluster",
        "slot",
        "owner_program",
        "decimals",
        "supply_raw",
        "mint_authority",
        "freeze_authority",
        "metadata_name",
        "metadata_symbol",
        "verified_by",
        "verified_at"
      ],
      "until_verified": "null everywhere; every feature that needs the main token stays off or hidden",
      "used_for": [
        "founder_selection_balance",
        "tie_break_raw_balance",
        "national_rank_balance",
        "balance_sampling",
        "holder_list",
        "token_page",
        "purchase_links",
        "main_token_quote"
      ],
      "holder_migration": "none: no automatic swap, migration, airdrop or transfer of anyone's holdings",
      "purchase_links": {
        "source": "the configured, verified main-token mint only",
        "shown_when": "a real route exists, checked by a live quote",
        "otherwise": "hidden",
        "for_legacy_tokens": false
      }
    },
    "legacy_tokens": [
      {
        "symbol": "$VICINITY",
        "mint": "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray",
        "role": "legacy, history only",
        "automatic_swap_or_migration": false,
        "holders_keep_their_tokens": true,
        "never_used_for": [
          "main_token",
          "balance_tracking",
          "founder_selection",
          "manager_ranking",
          "purchase_links",
          "main_token_quote"
        ],
        "presentation": "clearly labeled legacy; no swap or buy offered"
      }
    ],
    "official_links": {
      "x_url": null,
      "telegram_url": null,
      "config_keys": {
        "x_url": "OFFICIAL_X_URL",
        "telegram_url": "OFFICIAL_TELEGRAM_URL"
      },
      "rule": "owner-supplied and verified; empty means not shown",
      "x_url_form": "https://x.com/<handle> with a handle of 1 to 15 characters from A-Z, a-z, 0-9 and _; a twitter.com address is accepted and normalized to x.com",
      "telegram_url_form": "https://t.me/<name> with a name of 5 to 32 characters from A-Z, a-z, 0-9 and _",
      "verification_record": [
        "url",
        "account_name_shown",
        "checked_by",
        "checked_at",
        "evidence"
      ],
      "legacy": {
        "x_url": "https://x.com/VicinityCitySOL"
      }
    },
    "identity": {
      "authentication": "wallet_only",
      "unique_account_per_wallet": true,
      "initial_location_required": true,
      "returning_location_required": false,
      "challenge_seconds": 120,
      "challenge_single_use": true,
      "challenge_binds": [
        "origin",
        "cluster",
        "wallet",
        "nonce",
        "purpose",
        "expiry"
      ],
      "handoff_seconds": 300,
      "handoff_single_use": true,
      "handoff_binds": [
        "browser_session",
        "city",
        "country",
        "purpose",
        "nonce"
      ],
      "location_persisted": [
        "city_id",
        "country_id",
        "verified_at",
        "policy_version",
        "privacy_safe_attestation"
      ],
      "raw_coordinates_persisted": false,
      "self_service_relocation": false,
      "google_email_password_login": false,
      "email_auto_merge": false,
      "lost_key_founder_reassignment": false
    },
    "qualification": {
      "holding_wait_seconds": 0,
      "minimum_account_age": 0,
      "seven_day_streak": false,
      "stake_ladder": false,
      "founder_application_pitch": false,
      "opt_in_queue": false,
      "candidate_balance_rule": "strictly_positive_raw_main_token_balance"
    },
    "founder_selection": {
      "cycle_seconds": 21600,
      "epoch_formula": "floor(unix_seconds / 21600)",
      "clock": "UTC",
      "boundaries_utc": [
        "00:00",
        "06:00",
        "12:00",
        "18:00"
      ],
      "metric": "largest_positive_registered_city_balance",
      "balance_measure": "sum of integer base-unit balances over every token account the candidate wallet owns for the configured main-token mint (policy.main_token: MAIN_TOKEN_MINT after on-chain verification; never a legacy mint)",
      "excluded_holdings": [
        "pool_accounts",
        "program_accounts",
        "custodial_vault_accounts",
        "claimed_beneficial_ownership_elsewhere"
      ],
      "candidates": "successfully registered personal wallets assigned to the city before the cutoff, with a strictly positive verified main-token balance and no active account suspension",
      "cutoff": "one finalized slot at or immediately before the UTC boundary, with an auditable time-to-slot mapping",
      "snapshot_source": "historical indexer or suitable archival RPC; every candidate read at the same cutoff",
      "never_rank_by": [
        "city_token_balance",
        "activity_points",
        "trading_volume",
        "seven_day_average"
      ],
      "first_selection_for_new_city": "next_boundary",
      "processing_order": "earliest_unresolved_due_cycle_first",
      "empty_cycle": "close_as_no_eligible_holder_and_repeat_next_cycle",
      "data_failure": "stay_processing_and_retry_same_cutoff",
      "selection_is_terminal": true,
      "reselection": false,
      "founder_expiry": false,
      "founder_reassignment": false,
      "states": [
        "awaiting_selection",
        "processing_cutoff",
        "no_eligible_holder_next_cycle",
        "founder_selected"
      ],
      "launch_states": [
        "not_launched",
        "launched"
      ],
      "independent_verifier_required": true,
      "receipt_fields": [
        "snapshot_digest",
        "candidate_count",
        "cutoff_slot",
        "cutoff_time",
        "policy_version",
        "mint",
        "tie_break_receipt"
      ],
      "founder_record_fields": [
        "city",
        "country",
        "founder_wallet",
        "selection_cycle",
        "cutoff_slot",
        "snapshot_hash",
        "policy_version",
        "selection_time"
      ],
      "founder_record_authority": "on_chain_record_is_authoritative_for_launching"
    },
    "tie_break": {
      "order": [
        {
          "key": "raw_balance",
          "direction": "desc"
        },
        {
          "key": "signup_completed_at",
          "direction": "asc"
        },
        {
          "key": "wallet_public_key_bytes",
          "direction": "asc"
        }
      ],
      "wallet_key_form": "normalized_32_byte_public_key",
      "balance_mint": "policy.main_token (MAIN_TOKEN_MINT after on-chain verification; never a legacy mint)"
    },
    "country_manager": {
      "requires_founder_record_in_registered_country": true,
      "requires_confirmed_city_launch": true,
      "min_valid_activity_points": 100,
      "required_national_main_token_rank": 1,
      "national_rank_population": "all registered personal wallets in the country, not only founders",
      "national_rank_balance": "current finalized balance of the configured main-token mint (policy.main_token: MAIN_TOKEN_MINT after on-chain verification; never a legacy mint), strictly positive",
      "national_rank_tie_break": "same_as_tie_break",
      "requires_no_active_suspension": true,
      "owner_approval_required": true,
      "active_managers_per_country": 1,
      "automatic_rotation_or_removal": false,
      "application_states": [
        "draft",
        "submitted",
        "under_review",
        "approved",
        "rejected",
        "withdrawn",
        "needs_requalification"
      ],
      "eligibility_rechecked_at": [
        "submission",
        "approval"
      ],
      "approval_binds": [
        "country",
        "wallet"
      ],
      "one_open_application_per_wallet_country": true,
      "application_requires_location": false,
      "changes_city_founder": false
    },
    "activity": {
      "threshold": 100,
      "max_total": 130,
      "day_boundary": "UTC",
      "categories": {
        "launch": {
          "points": 40,
          "cap": 40,
          "daily_limit": null,
          "review": "confirmed_chain_state",
          "trigger": "one confirmed unique city launch matching the FounderRecord"
        },
        "post": {
          "points": 2,
          "cap": 20,
          "daily_limit": 1,
          "review": "moderation_and_duplicate_checks_then_automatic",
          "trigger": "nonduplicate, visible, non-spam original community post"
        },
        "reply": {
          "points": 1,
          "cap": 20,
          "daily_limit": 2,
          "self_replies": false,
          "review": "moderation_and_duplicate_checks_then_automatic",
          "trigger": "visible substantive reply to another member"
        },
        "initiative": {
          "points": 10,
          "cap": 30,
          "daily_limit": null,
          "review": "evidence_review_by_owner_or_authorized_moderator",
          "trigger": "evidence-backed completed initiative, distinct from posts and proposals"
        },
        "proposal": {
          "points": 5,
          "cap": 20,
          "daily_limit": null,
          "review": "evidence_review_by_owner_or_authorized_moderator",
          "trigger": "distinct actionable proposal; no duplicate initiative award"
        }
      },
      "non_earning": [
        "holding_tokens",
        "logging_in",
        "self_transfers",
        "buying_volume"
      ],
      "invalid_content_points": 0,
      "ledger": "append_only_with_reversal_rows",
      "event_fields": [
        "wallet_or_account",
        "city_or_country",
        "source_record",
        "event_type",
        "points",
        "policy_version",
        "review_state",
        "dedup_key",
        "reversal_link"
      ],
      "seven_day_minimum": false
    },
    "platform_fees": {
      "launch_fee": 0,
      "send_fee": 0,
      "receive_fee": 0,
      "chain_costs": "itemized_separately",
      "chain_cost_items": [
        "network_fee",
        "priority_fee",
        "token_account_rent",
        "mandatory_metadata_cost"
      ],
      "transfer_tax": false,
      "second_fee_on_bucket_forwarding": false
    },
    "trading": {
      "total_fee_bps": 250,
      "bps_denominator": 10000,
      "split_bps": {
        "liquidity": 50,
        "platform": 70,
        "founder": 50,
        "holders": 50,
        "buyback": 30
      },
      "rounding": {
        "total": "floor(quote_basis * 250 / 10000)",
        "platform": "floor(quote_basis * 70 / 10000)",
        "founder": "floor(quote_basis * 50 / 10000)",
        "holders": "floor(quote_basis * 50 / 10000)",
        "buyback": "floor(quote_basis * 30 / 10000)",
        "liquidity": "total - platform - founder - holders - buyback"
      },
      "buy_basis": "gross quote actually consumed, including the fee",
      "sell_basis": "gross quote output before the fee",
      "unconsumed_final_fill_input": "returned",
      "founder_share_destination": "permanent selected city founder",
      "holder_share_destination": "holders of that city coin",
      "applies_to": "trades through the custom curve and internal pool only",
      "min_received_bound_required": true,
      "admin_reserve_or_lp_withdrawal": false,
      "live_status_source": "deployment and chain configuration state, never this policy"
    },
    "distribution": {
      "hour_seconds": 3600,
      "clock": "UTC",
      "processing": "automatic_bounded",
      "owner_action_per_hour": false,
      "record_key": [
        "cluster",
        "program",
        "coin",
        "quote_mint",
        "utc_hour",
        "action",
        "batch"
      ],
      "holdings_basis": "preceding UTC hour's confirmed city-token holdings",
      "samples_per_hour": 4,
      "sample_segment_seconds": 900,
      "sample_rule": "one non-preannounced sample inside each 15-minute segment, plus the cutoff balance",
      "weight": "min(cutoff_balance, arithmetic_mean(samples))",
      "weight_math": "exact_rational_integer",
      "included_holders": "positive-weight personal holders of that city coin",
      "excluded_holders": [
        "pool_program_and_distribution_vault_balances",
        "configured_treasury_and_service_wallets",
        "permanent_economic_founder"
      ],
      "allocation": "pro_rata_floor_base_units",
      "rounding_dust": "retained_and_carried",
      "no_valid_recipient_weight": "carry_to_next_valid_hour",
      "partial_hour_without_four_reliable_samples": "carry_holder_bucket_forward",
      "minimum_recipients": 0,
      "old_weekly_minimums_apply": false,
      "root_authority": "2_of_2_automated_snapshot_verifiers",
      "root_verifiers_agree_on": [
        "cutoff",
        "recipient_list_hash",
        "quote",
        "funded_amount",
        "policy"
      ],
      "holder_payout": "program_verified_push_batches_to_leaf_wallet_canonical_quote_token_account",
      "recovery_claim": "wallet_signed_proof_claim_without_double_payment",
      "funded_allocations_expire": false,
      "administrative_sweep": false,
      "platform_payout": "automatic transfer to the verified configured treasury, per quote",
      "founder_payout": "automatic permissionless fixed-destination transfer to the permanent founder wallet",
      "liquidity_processing": "pregraduation fees stay locked in their bucket; after graduation a trade adds its own liquidity share plus a drip no larger than that share",
      "keeper_costs": "separate_operations_budget_never_from_holder_allocations",
      "failure_isolation": "one failed destination, quote or coin never halts the others"
    },
    "buyback": {
      "mechanism": "permissionless_no_fee_buy_and_burn",
      "first_run_min_slots_after_launch": 150,
      "min_slots_between_runs": 150,
      "depth_divisor": 1000,
      "per_run_cap": "min(floor(current_quote_depth / 1000), buyback_pending)",
      "config_rule": "25 * buyback_bps <= 3 * total_fee_bps",
      "may_trigger_graduation": false,
      "venue": "the coin's own curve or internal pool",
      "purchased_tokens": "burned",
      "catch_up_compression": false,
      "backlog_alert_run_capacities": 2,
      "price_support_marketing": false
    },
    "quote_configs": {
      "sol": {
        "config_id": 0,
        "quote_symbol": "SOL",
        "quote_mint": "So11111111111111111111111111111111111111112",
        "quote_custody": "wsol_adapter_for_native_sol",
        "quote_decimals": 9,
        "token_decimals": 6,
        "requires_revoked_mint_and_freeze_authority": false,
        "preburn_supply": {
          "tokens": "1000000000",
          "raw": "1000000000000000"
        },
        "curve_tokens": {
          "tokens": "793099990",
          "raw": "793099990000000"
        },
        "pool_allocation": {
          "tokens": "206900000.9",
          "raw": "206900000900000"
        },
        "launch_burn": {
          "tokens": "9.1",
          "raw": "9100000"
        },
        "graduation": {
          "quote": "85",
          "raw": "85000000000"
        },
        "virtual_quote_reserve": {
          "quote": "30.000853639",
          "raw": "30000853639"
        },
        "virtual_token_reserve": {
          "tokens": "1073025598.486615",
          "raw": "1073025598486615"
        },
        "min_buy": {
          "quote": "0.0001",
          "raw": "100000"
        },
        "min_sell": null,
        "derivation": "source config #0",
        "activation": "first production path, after the release gates"
      },
      "usdc": {
        "config_id": null,
        "quote_symbol": "USDC",
        "quote_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "quote_custody": "quote_token_vault",
        "quote_decimals": 6,
        "token_decimals": 6,
        "requires_revoked_mint_and_freeze_authority": false,
        "preburn_supply": {
          "tokens": "1000000000",
          "raw": "1000000000000000"
        },
        "curve_tokens": {
          "tokens": "793099990",
          "raw": "793099990000000"
        },
        "pool_allocation": {
          "tokens": "206900000.9",
          "raw": "206900000900000"
        },
        "launch_burn": {
          "tokens": "9.1",
          "raw": "9100000"
        },
        "graduation": {
          "quote": "10000",
          "raw": "10000000000"
        },
        "virtual_quote_reserve": null,
        "virtual_token_reserve": null,
        "min_buy": {
          "quote": "0.01",
          "raw": "10000"
        },
        "min_sell": null,
        "derivation": "same city-token allocations and curve shape as SOL; quote parameters scaled from the SOL curve in human units, converted with the quote decimals, then the integer terminal fill solved so that the curve reaches exactly the configured graduation",
        "activation": "only with its own passing evidence"
      },
      "main_token": {
        "config_id": null,
        "quote_symbol": "main token (symbol read from the verified MAIN_TOKEN_MINT)",
        "quote_mint": null,
        "quote_mint_source": "policy.main_token (MAIN_TOKEN_MINT), only after on-chain verification and the quote safety checks; never a legacy mint",
        "quote_custody": "quote_token_vault",
        "quote_decimals": null,
        "token_decimals": 6,
        "requires_revoked_mint_and_freeze_authority": true,
        "preburn_supply": {
          "tokens": "1000000000",
          "raw": "1000000000000000"
        },
        "curve_tokens": {
          "tokens": "793099990",
          "raw": "793099990000000"
        },
        "pool_allocation": {
          "tokens": "206900000.9",
          "raw": "206900000900000"
        },
        "launch_burn": {
          "tokens": "9.1",
          "raw": "9100000"
        },
        "graduation": {
          "quote": "1000000",
          "raw": null
        },
        "virtual_quote_reserve": null,
        "virtual_token_reserve": null,
        "min_buy": {
          "quote": "1",
          "raw": null
        },
        "min_sell": null,
        "derivation": "same city-token allocation and curve shape as SOL, with a 1,000,000 main-token-unit graduation and a 1-unit minimum buy; the raw amounts follow from the verified mint's on-chain decimals, so they stay null until the mint is supplied and verified",
        "activation": "only when the configured main-token mint is verified and passes the quote safety checks, and only with its own passing evidence"
      }
    },
    "quote_safety": {
      "supported_token_program": "classic_spl_token",
      "token_2022": "unavailable_unless_implemented_and_tested",
      "added_quotes_require_revoked_mint_and_freeze_authority": true,
      "standard_transfers_required": true,
      "city_coin_as_own_quote": false,
      "mismatched_vaults": "rejected",
      "onboarding": "governance_admin_configuration",
      "founder_choice": "enabled_list_only",
      "failed_mint": "rejected_with_reason_never_routed_to_an_external_venue",
      "price_oracle_required_for_graduation": false,
      "unknown_value_display": "unavailable_not_zero"
    },
    "metadata": {
      "defaults": "fixed_owner_approved",
      "default_fields": [
        "ticker",
        "image",
        "description"
      ],
      "description_must_include": [
        "canonical_city",
        "state_or_region",
        "country",
        "actual_quote_pair"
      ],
      "region_not_applicable": "render_explicitly_never_fabricate",
      "pair_selector": "changes only the mandatory pair display, from approved quote configs",
      "direct_founder_edit": false,
      "request_submitter": "permanent_founder_of_the_unlaunched_city",
      "request_fields": [
        "ticker",
        "image",
        "description",
        "reason",
        "base_registry_version"
      ],
      "open_requests_per_city": 1,
      "request_states": [
        "draft",
        "submitted",
        "under_review",
        "approved_publishing",
        "active",
        "rejected",
        "withdrawn",
        "superseded"
      ],
      "launch_frozen_states": [
        "submitted",
        "under_review",
        "approved_publishing"
      ],
      "review_lock_on_chain": true,
      "reviewer": "owner",
      "approval_publishes": "new versioned default: asset and metadata hashes and registry root, then the default updated atomically",
      "approval_specific_to": [
        "proposal",
        "base_version"
      ],
      "changed_request_needs_new_review": true,
      "complete_before_chain_confirmation": false,
      "post_launch_changes": false,
      "per_launch_owner_approval": false,
      "rejection_effect": "current defaults stay; the founder may launch with them or submit a corrected request; founder status is unchanged",
      "ticker_rule": "versioned normalization, bounded length, globally unique ticker lock, deterministic collision resolution before publishing",
      "metadata_uri": "permanent citycoin.dev versioned endpoint plus an independent archive for new coins; immutable legacy URIs preserved",
      "one_launch_per_city": "across old and new programs, with permanent city and ticker locks after launch",
      "image": {
        "types": [
          "image/png",
          "image/jpeg",
          "image/webp"
        ],
        "max_bytes": 10000000,
        "max_width_px": 4096,
        "max_height_px": 4096,
        "strip_exif_and_location": true,
        "verify_file_signature": true,
        "rejected_content": [
          "svg",
          "html",
          "executable"
        ],
        "uploads_private_until_reviewed": true,
        "approved_storage": "content_addressed_durable"
      }
    },
    "public_policy": {
      "exposed": [
        "policy_version",
        "owner_delegation_date",
        "active_pairs",
        "selection_schedule",
        "fee_status",
        "hourly_job_status",
        "public_authority_addresses"
      ],
      "never_exposed": [
        "secrets",
        "handoff_tokens",
        "coordinates",
        "sensitive_applicant_evidence"
      ],
      "status_labels": [
        "historical",
        "approved_target",
        "active"
      ],
      "countdown_clock": "server_time"
    },
    "authorities": {
      "user_wallet": "login and user-authorized transactions only; no server custody",
      "selection_signers": "constrained selection publisher plus independent verifier; one-time selections only",
      "hourly_root_authority": "2_of_2_automated_verifiers_holder_roots_only",
      "keeper": "permissionless fixed-destination operations and capped buybacks only",
      "owner_application_admin": "reviews country managers, activity evidence and metadata proposals; publishes approved metadata defaults; no founder selection and no per-launch approval",
      "governance_threshold": "2_of_3_existing_squads_member_set",
      "upgrade_delay_hours": 48,
      "guardian_threshold": "2_of_3_existing_member_set_distinct_multisig",
      "guardian_time_lock": "none",
      "guardian_powers": [
        "stop_new_selections",
        "stop_launches",
        "stop_buys",
        "stop_buybacks",
        "stop_bad_pending_roots"
      ],
      "guardian_forbidden": [
        "reassign",
        "resume",
        "upgrade",
        "arbitrary_withdraw"
      ],
      "treasury": "dedicated verified fixed public destination",
      "web_server_holds_treasury_upgrade_or_member_keys": false
    },
    "release_gates": {
      "independent_audit_before_mainnet_financial_activation": true,
      "local_and_testnet_end_to_end_rehearsal": true,
      "shadow_operation_hours": 48,
      "accelerated_multicycle_and_monetary_stress_tests": true,
      "initial_city_count_min": 1,
      "initial_city_count_max": 3,
      "initial_path": "audited_sol_path",
      "observation_hours_before_expanding": 72,
      "observation_condition": "no unresolved critical or high issue",
      "per_quote_path_evidence": true,
      "legacy_new_launch_disable_before_new_launches": true,
      "website_rebrand_independent_of_financial_activation": true,
      "legacy_redirect_min_months": 12,
      "legacy_immutable_metadata": "exact bytes served as long as existing assets depend on them; never redirected",
      "replaces": "previous 30-day rotation-specific gate",
      "fabricated_elapsed_time": false
    }
  },
  "deployment": {
    "environment": "unset",
    "fixture": false,
    "flags": {
      "WALLET_ONLY": "off",
      "LEGACY_LINK": "off",
      "LEGACY_SEATS": "on",
      "SELECTION_V5": "off",
      "FOUNDER_RECORD_CHAIN": "off",
      "ACTIVITY_POINTS": "off",
      "MANAGER_APPS": "off",
      "METADATA_V5": "off",
      "LAUNCH_V5": "off",
      "LEGACY_LAUNCH": "on",
      "CC_TRADING": "off",
      "CC_HOURLY": "off",
      "HOST_REDIRECT": "off",
      "PUBLIC_V5": "off",
      "MAIN_TOKEN_V5": "off"
    },
    "inputs": {
      "SITE_ORIGIN": null,
      "SITE_ORIGINS": [],
      "LEGACY_LINK_UNTIL": null,
      "MAIN_TOKEN_MINT": null,
      "OFFICIAL_X_URL": null,
      "OFFICIAL_TELEGRAM_URL": null,
      "cluster": null,
      "program_id": null,
      "governance_vault": null,
      "treasury": null,
      "keeper": null,
      "selection_publisher": null,
      "selection_verifier": null,
      "hourly_verifier_a": null,
      "hourly_verifier_b": null,
      "metadata_admin": null,
      "guardian": null,
      "enabled_quote_configs": [],
      "quote_mint_facts": {},
      "secrets_present": {
        "SELECTION_ARCHIVE_URL_A": false,
        "SELECTION_ARCHIVE_URL_B": false
      }
    }
  },
  "master_sections_rule": "Each string in master_sections names the master section of the value at the same path in policy or deployment. A string at an object's position covers every value inside that object.",
  "master_sections": {
    "policy_version": "§16 preamble",
    "owner_delegation_date": "§16 preamble; §01 Authority and precedence",
    "policy": {
      "pairs_and_branding": {
        "product_name": "§16 Pairs and branding; §02",
        "canonical_origin": "§04 BR-02",
        "legacy_origin": "§04 BR-02; §02",
        "main_token_label": "§02 Important identity distinction; §14 Main token",
        "trading_venue": "§16 Pairs and branding; §27 WP-08",
        "external_venue_for_new_path": "§27 WP-08; §02 Launch and trading",
        "quote_assets": "§16 Pairs and branding; §28 WP-08A"
      },
      "main_token": "§16 Pairs and branding; §02 Important identity distinction; §07 BR-05; §14 Main token; each as amended by amendment 01 (2026-10-24): a new, owner-supplied main-token mint, verified on chain and configured centrally as MAIN_TOKEN_MINT",
      "legacy_tokens": "§07 BR-05 (history); §03 History and attribution; amendment 01 (2026-10-24): $VICINITY is a legacy token, history only, with no automatic swap or migration",
      "official_links": "§06 BR-04 (official social profiles); amendment 01 (2026-10-24): new official X and Telegram links, owner-supplied, verified and configured centrally; the old X account is legacy",
      "identity": {
        "authentication": "§16 Identity",
        "unique_account_per_wallet": "§16 Identity; §18 WP-02",
        "initial_location_required": "§16 Identity; §19 WP-03",
        "returning_location_required": "§16 Identity; §19 WP-03",
        "challenge_seconds": "§18 WP-02 (two-minute challenges)",
        "challenge_single_use": "§18 WP-02 (one-use nonces)",
        "challenge_binds": "§18 WP-02; §05 BR-03",
        "handoff_seconds": "§19 WP-03 step 4 (five minutes)",
        "handoff_single_use": "§19 WP-03 step 4; §05 BR-03",
        "handoff_binds": "§19 WP-03 step 4",
        "location_persisted": "§19 WP-03 step 3",
        "raw_coordinates_persisted": "§19 WP-03 step 3; §06 BR-04 Analytics",
        "self_service_relocation": "§19 WP-03 Permanent assignment",
        "google_email_password_login": "§18 WP-02; §05 BR-03; §15",
        "email_auto_merge": "§18 WP-02; §05 BR-03",
        "lost_key_founder_reassignment": "§18 WP-02; §21 WP-05"
      },
      "qualification": {
        "holding_wait_seconds": "§16 Qualification",
        "minimum_account_age": "§16 Qualification",
        "seven_day_streak": "§16 Qualification; §15",
        "stake_ladder": "§16 Qualification; §15",
        "founder_application_pitch": "§16 Qualification",
        "opt_in_queue": "§16 Configuration acceptance; §20 WP-04",
        "candidate_balance_rule": "§16 Configuration acceptance; §20 WP-04"
      },
      "founder_selection": {
        "cycle_seconds": "§16 Founder selection",
        "epoch_formula": "§16 Founder selection",
        "clock": "§16 Founder selection; §20 WP-04",
        "boundaries_utc": "§20 WP-04 Scheduling",
        "metric": "§16 Founder selection",
        "balance_measure": "§20 WP-04 Candidate and balance rules; amendment 01 (the configured main-token mint)",
        "excluded_holdings": "§20 WP-04 Candidate and balance rules",
        "candidates": "§20 WP-04 Candidate and balance rules",
        "cutoff": "§20 WP-04 Candidate and balance rules",
        "snapshot_source": "§20 WP-04 Candidate and balance rules",
        "never_rank_by": "§20 WP-04 lead",
        "first_selection_for_new_city": "§20 WP-04 Scheduling",
        "processing_order": "§20 WP-04 Scheduling",
        "empty_cycle": "§20 WP-04 Scheduling; §21 WP-05",
        "data_failure": "§20 WP-04; §21 WP-05",
        "selection_is_terminal": "§16 Founder selection; §21 WP-05",
        "reselection": "§21 WP-05; §15",
        "founder_expiry": "§21 WP-05; §15",
        "founder_reassignment": "§21 WP-05; §15",
        "states": "§21 WP-05 Authoritative state machine",
        "launch_states": "§21 WP-05 Authoritative state machine",
        "independent_verifier_required": "§21 WP-05; §36 WP-12",
        "receipt_fields": "§20 WP-04 Candidate and balance rules",
        "founder_record_fields": "§21 WP-05",
        "founder_record_authority": "§21 WP-05"
      },
      "tie_break": {
        "order": "§16 Tie-break; §20 WP-04",
        "wallet_key_form": "§16 Tie-break",
        "balance_mint": "§16 Tie-break; §20 WP-04; amendment 01 (the configured main-token mint)"
      },
      "country_manager": {
        "requires_founder_record_in_registered_country": "§16 Country manager; §22 WP-06",
        "requires_confirmed_city_launch": "§16 Country manager; §22 WP-06",
        "min_valid_activity_points": "§16 Country manager; §22 WP-06; §23 WP-06A",
        "required_national_main_token_rank": "§16 Country manager; §22 WP-06",
        "national_rank_population": "§22 WP-06 Main-token rank",
        "national_rank_balance": "§22 WP-06 Main-token rank; amendment 01 (the configured main-token mint)",
        "national_rank_tie_break": "§22 WP-06 Main-token rank",
        "requires_no_active_suspension": "§16 Country manager; §22 WP-06",
        "owner_approval_required": "§16 Country manager; §22 WP-06",
        "active_managers_per_country": "§22 WP-06 Application lifecycle",
        "automatic_rotation_or_removal": "§22 WP-06 Application lifecycle",
        "application_states": "§22 WP-06 Application lifecycle",
        "eligibility_rechecked_at": "§22 WP-06 Application lifecycle",
        "approval_binds": "§22 WP-06 Application lifecycle",
        "one_open_application_per_wallet_country": "§22 WP-06 Application lifecycle",
        "application_requires_location": "§22 WP-06 Application; §19 WP-03",
        "changes_city_founder": "§22 WP-06; §35 WP-11"
      },
      "activity": {
        "threshold": "§23 WP-06A",
        "max_total": "§23 WP-06A",
        "day_boundary": "§23 WP-06A",
        "categories": {
          "launch": {
            "points": "§23 WP-06A",
            "cap": "§23 WP-06A",
            "daily_limit": "§23 WP-06A",
            "review": "§23 WP-06A; §22 WP-06 Confirmed launch",
            "trigger": "§23 WP-06A"
          },
          "post": {
            "points": "§23 WP-06A",
            "cap": "§23 WP-06A",
            "daily_limit": "§23 WP-06A",
            "review": "§23 WP-06A Ledger and abuse controls",
            "trigger": "§23 WP-06A"
          },
          "reply": {
            "points": "§23 WP-06A",
            "cap": "§23 WP-06A",
            "daily_limit": "§23 WP-06A",
            "self_replies": "§23 WP-06A",
            "review": "§23 WP-06A Ledger and abuse controls",
            "trigger": "§23 WP-06A"
          },
          "initiative": {
            "points": "§23 WP-06A",
            "cap": "§23 WP-06A",
            "daily_limit": "§23 WP-06A",
            "review": "§23 WP-06A",
            "trigger": "§23 WP-06A"
          },
          "proposal": {
            "points": "§23 WP-06A",
            "cap": "§23 WP-06A",
            "daily_limit": "§23 WP-06A",
            "review": "§23 WP-06A",
            "trigger": "§23 WP-06A"
          }
        },
        "non_earning": "§23 WP-06A lead",
        "invalid_content_points": "§23 WP-06A Ledger and abuse controls",
        "ledger": "§23 WP-06A Ledger and abuse controls",
        "event_fields": "§23 WP-06A Ledger and abuse controls",
        "seven_day_minimum": "§22 WP-06 Activity"
      },
      "platform_fees": {
        "launch_fee": "§16 Platform fees; §29",
        "send_fee": "§16 Platform fees; §29",
        "receive_fee": "§16 Platform fees; §29",
        "chain_costs": "§16 Platform fees; §29",
        "chain_cost_items": "§29 Zero launch/send/receive platform fees",
        "transfer_tax": "§29",
        "second_fee_on_bucket_forwarding": "§29 Trade accounting rules"
      },
      "trading": {
        "total_fee_bps": "§16 Trading; §29",
        "bps_denominator": "§29 Trade accounting rules",
        "split_bps": "§16 Trading; §29 Approved trade fee",
        "rounding": "§29 Trade accounting rules",
        "buy_basis": "§29 Trade accounting rules",
        "sell_basis": "§29 Trade accounting rules",
        "unconsumed_final_fill_input": "§29 Trade accounting rules; §27 WP-08",
        "founder_share_destination": "§29 Trade accounting rules",
        "holder_share_destination": "§29 Trade accounting rules",
        "applies_to": "§29 Trade accounting rules",
        "min_received_bound_required": "§27 WP-08 (SDK requires a positive minimum-received/slippage bound)",
        "admin_reserve_or_lp_withdrawal": "§27 WP-08 (no admin reserve/LP withdrawal)",
        "live_status_source": "§16 Trading; §16 Configuration acceptance"
      },
      "distribution": {
        "hour_seconds": "§16 Distribution",
        "clock": "§16 Distribution; §30 WP-09",
        "processing": "§16 Distribution",
        "owner_action_per_hour": "§30 WP-09",
        "record_key": "§30 WP-09 Job and recovery contract; §16 Distribution",
        "holdings_basis": "§31 WP-09A",
        "samples_per_hour": "§31 WP-09A",
        "sample_segment_seconds": "§31 WP-09A",
        "sample_rule": "§31 WP-09A",
        "weight": "§31 WP-09A",
        "weight_math": "§31 WP-09A",
        "included_holders": "§31 WP-09A",
        "excluded_holders": "§31 WP-09A",
        "allocation": "§31 WP-09A",
        "rounding_dust": "§31 WP-09A",
        "no_valid_recipient_weight": "§31 WP-09A",
        "partial_hour_without_four_reliable_samples": "§31 WP-09A",
        "minimum_recipients": "§31 WP-09A",
        "old_weekly_minimums_apply": "§31 WP-09A; §15",
        "root_authority": "§31 WP-09A Automatic root authorization; §36 WP-12",
        "root_verifiers_agree_on": "§31 WP-09A Automatic root authorization",
        "holder_payout": "§31 WP-09A Automatic root authorization",
        "recovery_claim": "§31 WP-09A Automatic root authorization",
        "funded_allocations_expire": "§31 WP-09A",
        "administrative_sweep": "§31 WP-09A",
        "platform_payout": "§30 WP-09 Process each hour",
        "founder_payout": "§30 WP-09 Process each hour",
        "liquidity_processing": "§30 WP-09; §32 WP-09B; §27 WP-08",
        "keeper_costs": "§30 WP-09 Job and recovery contract; §31 WP-09A",
        "failure_isolation": "§30 WP-09 Job and recovery contract"
      },
      "buyback": {
        "mechanism": "§32 WP-09B",
        "first_run_min_slots_after_launch": "§32 WP-09B",
        "min_slots_between_runs": "§32 WP-09B",
        "depth_divisor": "§32 WP-09B",
        "per_run_cap": "§32 WP-09B",
        "config_rule": "§32 WP-09B",
        "may_trigger_graduation": "§32 WP-09B",
        "venue": "§32 WP-09B",
        "purchased_tokens": "§32 WP-09B",
        "catch_up_compression": "§32 WP-09B",
        "backlog_alert_run_capacities": "§32 WP-09B",
        "price_support_marketing": "§32 WP-09B"
      },
      "quote_configs": {
        "sol": {
          "config_id": "§27 WP-08 (source config #0)",
          "quote_symbol": "§27 WP-08",
          "quote_mint": "§28 WP-08A (WSOL adapter handles native SOL)",
          "quote_custody": "§28 WP-08A",
          "quote_decimals": "§28 WP-08A (read and validate decimals)",
          "token_decimals": "§27 WP-08",
          "requires_revoked_mint_and_freeze_authority": "§28 WP-08A (rule applies to added classic SPL quotes)",
          "preburn_supply": "§27 WP-08",
          "curve_tokens": "§27 WP-08",
          "pool_allocation": "§27 WP-08",
          "launch_burn": "§27 WP-08",
          "graduation": "§27 WP-08",
          "virtual_quote_reserve": "§27 WP-08",
          "virtual_token_reserve": "§27 WP-08",
          "min_buy": "§27 WP-08",
          "min_sell": "§27 WP-08 (no minimum sell)",
          "derivation": "§27 WP-08",
          "activation": "§37 WP-12A"
        },
        "usdc": {
          "config_id": "§28 WP-08A (assigned at governance onboarding)",
          "quote_symbol": "§27 WP-08",
          "quote_mint": "§28 WP-08A",
          "quote_custody": "§28 WP-08A",
          "quote_decimals": "§28 WP-08A; §27 WP-08",
          "token_decimals": "§27 WP-08",
          "requires_revoked_mint_and_freeze_authority": "§28 WP-08A (USDC is a named default, not an added quote)",
          "preburn_supply": "§27 WP-08 (same city-token allocations)",
          "curve_tokens": "§27 WP-08 (same city-token allocations)",
          "pool_allocation": "§27 WP-08 (same city-token allocations)",
          "launch_burn": "§27 WP-08 (same city-token allocations)",
          "graduation": "§27 WP-08",
          "virtual_quote_reserve": "§27 WP-08 (to be derived)",
          "virtual_token_reserve": "§27 WP-08 (to be derived)",
          "min_buy": "§27 WP-08",
          "min_sell": "§27 WP-08 (no minimum sell)",
          "derivation": "§27 WP-08",
          "activation": "§37 WP-12A"
        },
        "main_token": {
          "config_id": "§28 WP-08A (assigned at governance onboarding)",
          "quote_symbol": "§28 WP-08A; §14 Main token; amendment 01 (symbol read from the verified configured mint)",
          "quote_mint": "§28 WP-08A Concrete additional-SPL scope; amendment 01 (null until the configured mint is verified and passes the quote safety checks)",
          "quote_mint_source": "§28 WP-08A; amendment 01 (the configured main-token mint, never a legacy mint)",
          "quote_custody": "§28 WP-08A",
          "quote_decimals": "§28 WP-08A (read and validate decimals); amendment 01 (read from the verified configured mint)",
          "token_decimals": "§27 WP-08",
          "requires_revoked_mint_and_freeze_authority": "§28 WP-08A safety",
          "preburn_supply": "§28 WP-08A (same city-token allocation)",
          "curve_tokens": "§28 WP-08A (same city-token allocation)",
          "pool_allocation": "§28 WP-08A (same city-token allocation)",
          "launch_burn": "§28 WP-08A (same city-token allocation)",
          "graduation": "§28 WP-08A Concrete additional-SPL scope (rule unchanged); amendment 01 (raw amount from the verified decimals)",
          "virtual_quote_reserve": "§28 WP-08A (to be derived)",
          "virtual_token_reserve": "§28 WP-08A (to be derived)",
          "min_buy": "§28 WP-08A Concrete additional-SPL scope (rule unchanged); amendment 01 (raw amount from the verified decimals)",
          "min_sell": "§27 WP-08 (no minimum sell)",
          "derivation": "§28 WP-08A Concrete additional-SPL scope; amendment 01",
          "activation": "§28 WP-08A; §37 WP-12A; amendment 01 (the configured, verified mint only)"
        }
      },
      "quote_safety": {
        "supported_token_program": "§28 WP-08A extensions",
        "token_2022": "§28 WP-08A extensions",
        "added_quotes_require_revoked_mint_and_freeze_authority": "§28 WP-08A safety",
        "standard_transfers_required": "§28 WP-08A safety",
        "city_coin_as_own_quote": "§28 WP-08A safety",
        "mismatched_vaults": "§28 WP-08A safety",
        "onboarding": "§28 WP-08A activation",
        "founder_choice": "§28 WP-08A activation",
        "failed_mint": "§28 WP-08A Concrete additional-SPL scope",
        "price_oracle_required_for_graduation": "§28 WP-08A liquidity / valuation",
        "unknown_value_display": "§28 WP-08A liquidity / valuation"
      },
      "metadata": {
        "defaults": "§16 Metadata changes; §25",
        "default_fields": "§25",
        "description_must_include": "§16 Metadata changes; §24 WP-07",
        "region_not_applicable": "§24 WP-07 Implementation tasks",
        "pair_selector": "§25 Default preview",
        "direct_founder_edit": "§25; §24 WP-07; §40 M01",
        "request_submitter": "§25 Founder request",
        "request_fields": "§25 Founder request",
        "open_requests_per_city": "§25 Exact state and consistency rules",
        "request_states": "§25 Exact state and consistency rules",
        "launch_frozen_states": "§25 Exact state and consistency rules; §40 M02",
        "review_lock_on_chain": "§25 Exact state and consistency rules",
        "reviewer": "§16 Metadata changes; §25 Owner review",
        "approval_publishes": "§25 Approval; §24 WP-07",
        "approval_specific_to": "§25 Exact state and consistency rules",
        "changed_request_needs_new_review": "§25 Exact state and consistency rules",
        "complete_before_chain_confirmation": "§25 Exact state and consistency rules",
        "post_launch_changes": "§24 WP-07; §25",
        "per_launch_owner_approval": "§25 Launch; §26 WP-07A; §36 WP-12",
        "rejection_effect": "§25 Rejected / withdrawn",
        "ticker_rule": "§24 WP-07 name / symbol",
        "metadata_uri": "§24 WP-07 metadata_uri; §04 BR-02",
        "one_launch_per_city": "§24 WP-07 Coin / ticker lock",
        "image": {
          "types": "§25 Exact state and consistency rules",
          "max_bytes": "§25 (10 MB, read as 10,000,000 bytes)",
          "max_width_px": "§25 (4096 x 4096 decoded pixels)",
          "max_height_px": "§25 (4096 x 4096 decoded pixels)",
          "strip_exif_and_location": "§25",
          "verify_file_signature": "§25",
          "rejected_content": "§25",
          "uploads_private_until_reviewed": "§25",
          "approved_storage": "§25"
        }
      },
      "public_policy": {
        "exposed": "§16 Public policy",
        "never_exposed": "§16 Public policy; §23 WP-06A",
        "status_labels": "§35 WP-11; §08 BR-06",
        "countdown_clock": "§33 WP-10"
      },
      "authorities": {
        "user_wallet": "§36 WP-12",
        "selection_signers": "§36 WP-12; §21 WP-05",
        "hourly_root_authority": "§36 WP-12; §31 WP-09A",
        "keeper": "§36 WP-12",
        "owner_application_admin": "§36 WP-12",
        "governance_threshold": "§36 WP-12",
        "upgrade_delay_hours": "§36 WP-12",
        "guardian_threshold": "§36 WP-12",
        "guardian_time_lock": "§36 WP-12",
        "guardian_powers": "§36 WP-12",
        "guardian_forbidden": "§36 WP-12",
        "treasury": "§36 WP-12",
        "web_server_holds_treasury_upgrade_or_member_keys": "§36 WP-12"
      },
      "release_gates": {
        "independent_audit_before_mainnet_financial_activation": "§37 WP-12A",
        "local_and_testnet_end_to_end_rehearsal": "§37 WP-12A",
        "shadow_operation_hours": "§37 WP-12A",
        "accelerated_multicycle_and_monetary_stress_tests": "§37 WP-12A",
        "initial_city_count_min": "§37 WP-12A",
        "initial_city_count_max": "§37 WP-12A",
        "initial_path": "§37 WP-12A",
        "observation_hours_before_expanding": "§37 WP-12A",
        "observation_condition": "§37 WP-12A",
        "per_quote_path_evidence": "§37 WP-12A",
        "legacy_new_launch_disable_before_new_launches": "§37 WP-12A step 9",
        "website_rebrand_independent_of_financial_activation": "§37 WP-12A",
        "legacy_redirect_min_months": "§04 BR-02",
        "legacy_immutable_metadata": "§04 BR-02",
        "replaces": "§37 WP-12A",
        "fabricated_elapsed_time": "§37 WP-12A; §01"
      }
    },
    "deployment": {
      "environment": "§16 Configuration acceptance (DESIGN: names proposed in R1-R5, none exists in src/flags.js at 4aa408e)",
      "fixture": "§16 Configuration acceptance (local fixtures are visibly test-only)",
      "flags": {
        "WALLET_ONLY": "§16 Configuration acceptance (DESIGN switch; R1)",
        "LEGACY_LINK": "§16 Configuration acceptance (DESIGN switch; R1)",
        "LEGACY_SEATS": "§16 Configuration acceptance (DESIGN switch; R2)",
        "SELECTION_V5": "§16 Configuration acceptance (DESIGN switch; R2)",
        "FOUNDER_RECORD_CHAIN": "§16 Configuration acceptance (DESIGN switch; R2)",
        "ACTIVITY_POINTS": "§16 Configuration acceptance (DESIGN switch; R2)",
        "MANAGER_APPS": "§16 Configuration acceptance (DESIGN switch; R2)",
        "METADATA_V5": "§16 Configuration acceptance (DESIGN switch; R3)",
        "LAUNCH_V5": "§16 Configuration acceptance (DESIGN switch; R3, the same switch R4 calls CC_LAUNCH)",
        "LEGACY_LAUNCH": "§16 Configuration acceptance (DESIGN switch; R3)",
        "CC_TRADING": "§16 Configuration acceptance (DESIGN switch; R4)",
        "CC_HOURLY": "§16 Configuration acceptance (DESIGN switch; R4)",
        "HOST_REDIRECT": "§16 Configuration acceptance (DESIGN switch; R5)",
        "PUBLIC_V5": "§16 Configuration acceptance (DESIGN switch; R5)",
        "MAIN_TOKEN_V5": "§16 Configuration acceptance (DESIGN switch; amendment 01: the token and official-link rollout)"
      },
      "inputs": {
        "SITE_ORIGIN": "§04 BR-02; §05 BR-03 (DESIGN input; R1)",
        "SITE_ORIGINS": "§05 BR-03 (DESIGN input; R1)",
        "LEGACY_LINK_UNTIL": "§05 BR-03 (DESIGN input; R1)",
        "MAIN_TOKEN_MINT": "§16 Configuration acceptance; amendment 01 (owner-supplied main-token mint, verified on chain before use)",
        "OFFICIAL_X_URL": "§06 BR-04; amendment 01 (owner-supplied official X link, verified before use; empty means not shown)",
        "OFFICIAL_TELEGRAM_URL": "§06 BR-04; amendment 01 (owner-supplied official Telegram link, verified before use; empty means not shown)",
        "cluster": "§16 Configuration acceptance; §36 WP-12",
        "program_id": "§16 Configuration acceptance; §27 WP-08",
        "governance_vault": "§36 WP-12",
        "treasury": "§36 WP-12; §30 WP-09",
        "keeper": "§36 WP-12; §30 WP-09",
        "selection_publisher": "§36 WP-12; §21 WP-05",
        "selection_verifier": "§36 WP-12; §21 WP-05",
        "hourly_verifier_a": "§36 WP-12; §31 WP-09A",
        "hourly_verifier_b": "§36 WP-12; §31 WP-09A",
        "metadata_admin": "§36 WP-12 (owner application admin)",
        "guardian": "§36 WP-12",
        "enabled_quote_configs": "§28 WP-08A activation",
        "quote_mint_facts": "§28 WP-08A (verify actual mint and owning program per cluster)",
        "secrets_present": {
          "SELECTION_ARCHIVE_URL_A": "§20 WP-04 (historical indexer or archival RPC; secret name only, R2)",
          "SELECTION_ARCHIVE_URL_B": "§20 WP-04 (second independent provider; secret name only, R2)"
        }
      }
    }
  },
  "code_verification": [
    {
      "path": "policy.quote_configs.sol (curve integers)",
      "status": "matches_draft",
      "master": "6 decimals; 1,000,000,000 preburn; 793,099,990 curve; 206,900,000.9 pool; 9.1 burn; 85 SOL; virtual 30.000853639 SOL and 1,073,025,598.486615 tokens; min buy 0.0001 SOL",
      "draft_program": "ConfigParams::DEFAULT virtual_sol 30_000_853_639, virtual_tokens 1_073_025_598_486_615, curve_supply 793_099_990_000_000, pool_supply 206_900_000_900_000, graduation_sol 85_000_000_000; COIN_SUPPLY 1_000_000_000_000_000; COIN_DECIMALS 6; MIN_TRADE_LAMPORTS 100_000; burn = COIN_SUPPLY - S - P = 9,100,000 raw",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/types.rs:66-78; solana/crates/vicinity-curve-math/src/constants.rs:8,11,32"
    },
    {
      "path": "policy.platform_fees.launch_fee",
      "status": "draft_differs",
      "master": "0",
      "draft_program": "config #0 launch_fee_lamports 50_000_000 (0.05 SOL), paid to FEE_RECIPIENT at launch when above zero; the cap allows up to 500_000_000; the SDK default is 50_000_000n",
      "live_site": "the live legacy Meteora config charges a 0.05 SOL launch fee (comment in wrangler.jsonc:70-72)",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/types.rs:77; solana/programs/vicinity-curve/src/instructions/launch.rs:328-340; solana/crates/vicinity-curve-math/src/constants.rs:71; solana/sdk/curve/math.mjs:144; citycoin 4aa408e wrangler.jsonc:70-72"
    },
    {
      "path": "policy.trading (split and rounding)",
      "status": "matches_draft",
      "master": "250 bps = 50/70/50/50/30; each of platform, founder, holders, buyback floored; liquidity is the remainder",
      "draft_program": "ConfigParams::DEFAULT liquidity 50, platform 70, founder 50, holders 50, buyback 30; fee_split floors fee and the four named shares and gives liquidity fee - named",
      "live_site": "live trading is the legacy Meteora config at 125 bps (comment in wrangler.jsonc:70-72); no city coin exists on it",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/types.rs:66-71; solana/crates/vicinity-curve-math/src/fee.rs:28-49"
    },
    {
      "path": "policy.buyback (interval and cap)",
      "status": "matches_draft",
      "master": "first run >= 150 slots after launch; at most one run per 150 slots; each run <= floor(current quote depth / 1000) and <= buyback_pending",
      "draft_program": "BUYBACK_INTERVAL_SLOTS 150 measured from last_buyback_slot; cap floor(depth * t / (25 * 10000)), which equals floor(depth / 1000) at t = 250; depth is x0 + curve_sol on the curve and pool_sol in the pool",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/constants.rs:36,40; solana/crates/vicinity-curve-math/src/trade.rs:253-267,289-296"
    },
    {
      "path": "policy.buyback.config_rule",
      "status": "draft_missing_in_program",
      "master": "25 * buyback_bps <= 3 * total_fee_bps enforced in program configuration and SDK",
      "draft_program": "SDK and deploy-checklist operating rule only (buybackKeepUp); the program's config validation does not enforce it (open owner decision O36, now settled by the master)",
      "evidence": "vcurve ec148c2 solana/sdk/curve/math.mjs:607-612; solana/VICINITY-CURVE-DESIGN.md:1940-1947"
    },
    {
      "path": "policy.quote_configs.usdc and policy.quote_configs.main_token",
      "status": "draft_missing",
      "master": "USDC: 10,000 USDC graduation, 0.01 USDC minimum buy; main token: 1,000,000-unit graduation, 1-unit minimum buy; same token allocations and shape",
      "draft_program": "SOL only: one global MIN_TRADE_LAMPORTS and graduation bounds in lamports (1 SOL to 10,000 SOL); no quote config, no token-vault custody",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/constants.rs:32,58,61"
    },
    {
      "path": "policy.quote_configs.usdc.virtual_quote_reserve, virtual_token_reserve; policy.quote_configs.main_token.virtual_quote_reserve, virtual_token_reserve",
      "status": "to_be_derived",
      "master": "scale the SOL curve's quote parameters in human units, convert with the quote decimals, solve the integer terminal fill, prove the exact configured graduation",
      "draft_program": "derive_curve exists; config rule V5 requires f(S) == R and V5b f(S - 1) <= R - 1; the values are deliberately null here until derived with that code and proven by a golden vector",
      "evidence": "vcurve ec148c2 solana/crates/vicinity-curve-math/src/config.rs:108,151,194,272"
    },
    {
      "path": "policy.main_token (mint facts)",
      "status": "awaiting_owner_value",
      "master": "amendment 01: an owner-supplied mint, verified on chain before use (policy.main_token.required_checks); the main-token quote additionally needs revoked mint and freeze authority",
      "chain": "nothing read: the owner has not supplied the new mint",
      "evidence": "none yet"
    },
    {
      "path": "policy.legacy_tokens ($VICINITY mint facts)",
      "status": "verified_on_chain_legacy",
      "master": "amendment 01: $VICINITY is a legacy token, history only; never the main token, the balance source or the main-token quote",
      "chain": "getMultipleAccounts (finalized, slot 460699237, 24 Oct 2026): owner TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, decimals 6, mint authority none, freeze authority none, raw supply 999999999999990",
      "evidence": "read-only RPC run for this file (recorded before amendment 01 as the main-token quote facts)"
    },
    {
      "path": "policy.main_token",
      "status": "live_differs",
      "master": "amendment 01: every main-token consumer reads MAIN_TOKEN_MINT after on-chain verification",
      "live_site": "every main-token consumer reads VICINITY_MINT, whose value is the legacy $VICINITY mint",
      "evidence": "citycoin 4aa408e wrangler.jsonc:32; src/official.js:11, 267-268; consumer list in docs/citycoin-master/amendment-01-new-main-token.md"
    },
    {
      "path": "policy.official_links",
      "status": "live_differs",
      "master": "amendment 01: OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL, owner-supplied and verified; empty means not shown",
      "live_site": "every page footer links the legacy X account, built from SOCIAL_PROFILES at page-build time; no Telegram is listed",
      "evidence": "citycoin 4aa408e src/official.js:24-26; scripts/pages/build.mjs:91-96, 158-159"
    },
    {
      "path": "policy.quote_configs.usdc (mint facts)",
      "status": "verified_on_chain_disclosure_needed",
      "master": "USDC is a named default quote; the revoked-authority rule is written for added classic SPL quotes",
      "chain": "same read: classic SPL Token, decimals 6, mint authority and freeze authority both present (held by the issuer); this file treats USDC as a named default that needs a public disclosure, which is an interpretation of section 28, not a separate owner decision",
      "evidence": "read-only RPC run for this file"
    },
    {
      "path": "policy.quote_configs.sol (WSOL mint facts)",
      "status": "verified_on_chain",
      "chain": "same read: So11111111111111111111111111111111111111112 is a classic SPL Token mint with 9 decimals and no mint or freeze authority",
      "evidence": "read-only RPC run for this file"
    },
    {
      "path": "policy.authorities.upgrade_delay_hours",
      "status": "live_differs",
      "master": "48-hour upgrade delay on the existing 2-of-3 Squads member set",
      "chain": "Squads multisig 6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV: threshold 2, time_lock 0 seconds (same read, slot 460699237)",
      "evidence": "read-only RPC run for this file"
    },
    {
      "path": "policy.authorities.treasury",
      "status": "draft_differs",
      "master": "dedicated verified fixed public destination",
      "draft_program": "FEE_RECIPIENT is the owner's everyday wallet 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN",
      "evidence": "vcurve ec148c2 solana/programs/vicinity-curve/src/constants.rs:18"
    },
    {
      "path": "policy.founder_selection.founder_reassignment",
      "status": "draft_conflicts",
      "master": "no reassignment, deletion, second selection or expiry",
      "draft_program": "transfer_founder lets a founder hand the seat to a co-signing key; no FounderRecord account exists",
      "evidence": "vcurve ec148c2 solana/programs/vicinity-curve/src/instructions/transfer_founder.rs:1-4"
    },
    {
      "path": "policy.metadata.metadata_uri",
      "status": "draft_differs",
      "master": "permanent citycoin.dev endpoint for new coins",
      "draft_program": "METADATA_URI_PREFIX is https://vicinity.city/coin-meta/",
      "evidence": "vcurve ec148c2 solana/programs/vicinity-curve/src/constants.rs:217"
    },
    {
      "path": "policy.identity.challenge_seconds and policy.identity.handoff_seconds",
      "status": "live_differs",
      "master": "120-second single-use challenge; 300-second single-use hand-off",
      "live_site": "a signed message is accepted for 10 minutes; GET /api/message mints a nonce but stores none; the wallet-app carry code and the location hand-off live 10 minutes",
      "evidence": "citycoin 4aa408e src/signed.js:9; src/index.js:501-502; src/walletlink.js:62; src/handoff.js:21"
    },
    {
      "path": "policy.qualification and policy.founder_selection",
      "status": "live_conflicts",
      "master": "no waiting period; six-hour largest-holder selection; permanent founder",
      "live_site": "policy version 6: 7-day qualifying hold, stake ladder, claim windows, grace, elections",
      "evidence": "citycoin 4aa408e src/policy.js:20-71"
    },
    {
      "path": "policy.metadata.image",
      "status": "live_differs",
      "master": "PNG, JPEG or WebP, up to 10 MB and 4096 x 4096, metadata stripped",
      "live_site": "uploaded pictures are limited to 200,000 bytes (MAX_IMAGE)",
      "evidence": "citycoin 4aa408e src/social.js:42"
    },
    {
      "path": "policy.distribution.funded_allocations_expire",
      "status": "live_differs",
      "master": "funded allocations stay owed until paid; no expiry or sweep",
      "live_site": "the vicinity_rewards program source in this repository sets a production minimum claim window of 14 days (MIN_CLAIM_WINDOW_SECS)",
      "evidence": "citycoin 4aa408e solana/programs/vicinity-rewards/src/constants.rs:44-48"
    },
    {
      "path": "policy.distribution.samples_per_hour",
      "status": "live_scheduler_insufficient",
      "master": "four non-preannounced samples, one inside each 15-minute segment",
      "live_site": "the only scheduler is a cron every 10 minutes, so some 15-minute segments contain exactly one tick and a sample there would be predictable; a finer scheduler is needed",
      "evidence": "citycoin 4aa408e wrangler.jsonc:141"
    }
  ]
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const MASTER_POLICY = deepFreeze(DOCUMENT);
export const POLICY_VERSION = MASTER_POLICY.policy_version;

const P = MASTER_POLICY.policy;
const CYCLE_SECONDS = P.founder_selection.cycle_seconds;

/* ------------------------------------------------------------------ small pure utilities */

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isLeaf = (v) => !isPlainObject(v) || Object.keys(v).length === 0;

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** True when `s` is base58 text of exactly 32 bytes (a Solana public key shape). Never touches a private key. */
function isPublicKey(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  return zeros + bytes === 32;
}

/* ------------------------------------------------------------------ founder selection clock (master sections 16, 20) */

/** A "seconds" value at or above this is almost certainly milliseconds (it would be the year 5138). */
const MILLISECONDS_GUARD = 1e11;

function unixSecondsOf(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number of Unix seconds`);
  if (Math.abs(value) >= MILLISECONDS_GUARD) throw new RangeError(`${name} looks like milliseconds: pass Unix seconds`);
  return Math.floor(value); // floor(floor(t) / c) == floor(t / c) for every real t and positive integer c
}

/** epoch = floor(unix_seconds / 21600). A time exactly on a boundary belongs to the epoch that starts there. */
export function selectionEpoch(unixSeconds) {
  return Math.floor(unixSecondsOf(unixSeconds, "unixSeconds") / CYCLE_SECONDS);
}

/** The boundary (Unix seconds) at which epoch `epoch` starts and its selection cutoff falls: 00:00, 06:00, 12:00 or 18:00 UTC. */
export function selectionBoundary(epoch) {
  if (!Number.isSafeInteger(epoch)) throw new TypeError("epoch must be a safe integer");
  return epoch * CYCLE_SECONDS;
}

/** The next selection boundary strictly after `unixSeconds` (a countdown target; at a boundary it is the following one). */
export function nextSelectionBoundary(unixSeconds) {
  return selectionBoundary(selectionEpoch(unixSeconds) + 1);
}

/* ------------------------------------------------------------------ trade fee split (master section 29) */

function amountOf(value, name) {
  let v;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer number of base units (use a BigInt above 2^53)`);
    v = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) v = BigInt(value);
  else throw new TypeError(`${name} must be a non-negative integer number of base units`);
  if (v < 0n) throw new RangeError(`${name} must not be negative`);
  return v;
}

/**
 * The five buckets of one trade's fee, in the quote's base units:
 *   total = floor(quote_basis * 250 / 10000); platform, founder, holders and buyback each floor(quote_basis * bps / 10000);
 *   liquidity = total - platform - founder - holders - buyback. The five always add up to `total` exactly.
 * quote_basis: for a buy, the gross quote actually consumed including the fee; for a sell, the gross quote output before the fee.
 */
export function tradeFeeSplit(quoteBasis) {
  const a = amountOf(quoteBasis, "quoteBasis");
  const t = P.trading;
  const D = BigInt(t.bps_denominator);
  const share = (bps) => (a * BigInt(bps)) / D; // BigInt division truncates; for a >= 0 that is the floor
  const total = share(t.total_fee_bps);
  const platform = share(t.split_bps.platform);
  const founder = share(t.split_bps.founder);
  const holders = share(t.split_bps.holders);
  const buyback = share(t.split_bps.buyback);
  const liquidity = total - platform - founder - holders - buyback;
  return Object.freeze({ quoteBasis: a, total, liquidity, platform, founder, holders, buyback });
}

/* ------------------------------------------------------------------ activity points (master section 23) */

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function instantOf(at, i) {
  if (at instanceof Date) {
    const ms = at.getTime();
    if (Number.isFinite(ms)) return ms;
  } else if (typeof at === "string" && ISO_WITH_ZONE.test(at)) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return ms;
  }
  throw new TypeError(`events[${i}].at must be a Date or an ISO 8601 time with a zone (Z or +hh:mm); numbers are refused so seconds and milliseconds cannot be mixed up`);
}

const EVIDENCE_REVIEW = "evidence_review_by_owner_or_authorized_moderator";

/**
 * Valid activity points from ledger-like events, applying the master's table: launch 40 (cap 40); posts 2 each (cap 20, at most
 * one credited per UTC day); replies 1 each (cap 20, at most two credited per UTC day, never to oneself); initiatives 10 each
 * (cap 30) and proposals 5 each (cap 20), both only once accepted by evidence review. Threshold 100 of at most 130.
 *
 * Event: { id, type, at, review_state?, invalid?, self_reply?, user_id?, parent_user_id?, dedup_key?, reverses_id? }
 *   - points come from the policy by `type`, never from the event; any other type (holding, logging in, buying...) earns nothing
 *   - review_state: launch, post and reply count when "auto" (the default) or "accepted"; initiative and proposal only "accepted"
 *   - invalid: true (spam, duplicate content, fabricated, removed) earns nothing
 *   - a row with reverses_id is a reversal: the event it names earns nothing (the ledger is append-only)
 *   - dedup_key: a second credited event with the same key earns nothing
 * Events are taken in time order (then by id), so the result does not depend on the input order. Daily limits use the UTC day.
 */
export function activityTotals(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const cats = P.activity.categories;
  const reversed = new Set();
  const ids = new Set();
  const rows = [];
  events.forEach((e, i) => {
    if (!isPlainObject(e)) throw new TypeError(`events[${i}] must be an object`);
    if (e.id === undefined || e.id === null || e.id === "") throw new TypeError(`events[${i}].id is required`);
    const key = String(e.id);
    if (ids.has(key)) throw new TypeError(`events[${i}].id repeats an earlier id`);
    ids.add(key);
    if (e.reverses_id !== undefined && e.reverses_id !== null) { reversed.add(String(e.reverses_id)); return; }
    rows.push({ e, key, at: instantOf(e.at, i) });
  });
  rows.sort((x, y) => x.at - y.at || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  const byCategory = Object.fromEntries(Object.keys(cats).map((k) => [k, 0]));
  const perDay = new Map();
  const dedup = new Set();
  const credited = [];
  const ignored = [];
  for (const { e, key, at } of rows) {
    const type = e.type;
    const skip = (reason) => ignored.push({ id: e.id, type, reason });
    const cat = typeof type === "string" && Object.prototype.hasOwnProperty.call(cats, type) ? cats[type] : null;
    if (reversed.has(key)) { skip("reversed"); continue; }
    if (!cat) { skip("not_an_activity"); continue; }
    if (e.invalid === true) { skip("invalid"); continue; }
    const needsEvidence = cat.review === EVIDENCE_REVIEW;
    const state = e.review_state === undefined || e.review_state === null ? (needsEvidence ? "pending" : "auto") : e.review_state;
    if (needsEvidence ? state !== "accepted" : state !== "auto" && state !== "accepted") { skip("not_accepted"); continue; }
    if (cat.self_replies === false && (e.self_reply === true
      || (e.user_id !== undefined && e.user_id !== null && e.parent_user_id !== undefined && e.parent_user_id !== null && String(e.user_id) === String(e.parent_user_id)))) { skip("self_reply"); continue; }
    const dk = e.dedup_key === undefined || e.dedup_key === null ? null : String(e.dedup_key);
    if (dk !== null && dedup.has(dk)) { skip("duplicate"); continue; }
    const room = cat.cap - byCategory[type];
    if (room <= 0) { skip("category_cap"); continue; }
    const day = new Date(at).toISOString().slice(0, 10);
    if (cat.daily_limit !== null) {
      const slot = `${type}|${day}`;
      const used = perDay.get(slot) || 0;
      if (used >= cat.daily_limit) { skip("daily_limit"); continue; }
      perDay.set(slot, used + 1);
    }
    if (dk !== null) dedup.add(dk);
    const points = Math.min(cat.points, room);
    byCategory[type] += points;
    credited.push({ id: e.id, type, points, day });
  }
  const total = Object.values(byCategory).reduce((s, n) => s + n, 0);
  return {
    policyVersion: POLICY_VERSION,
    total,
    byCategory,
    threshold: P.activity.threshold,
    maxTotal: P.activity.max_total,
    meetsThreshold: total >= P.activity.threshold,
    credited,
    ignored,
  };
}

/* ------------------------------------------------------------------ main token and official links (amendment 01) */

/** The legacy mints (policy.legacy_tokens): history only, never the main token, a balance source or the main-token quote. */
const LEGACY_MINTS = Object.freeze(P.legacy_tokens.map((t) => t.mint));
const xHandleOf = (url) => (/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})$/.exec(url) || [])[1];
/** The legacy X handles (policy.official_links.legacy), lower case: never accepted as the new official account. */
const LEGACY_X_HANDLES = Object.freeze([xHandleOf(P.official_links.legacy.x_url)].filter(Boolean).map((h) => h.toLowerCase()));

/** The features that read the main token. Each one needs a valid, non-legacy MAIN_TOKEN_MINT before it may be enabled. */
export const MAIN_TOKEN_FEATURES = deepFreeze(["selection", "manager_ranking", "token_page", "purchase_links", "main_token_quote"]);

// Paths that X and Telegram use for their own pages; they look like a handle but open no account.
const X_RESERVED = new Set(["home", "explore", "notifications", "messages", "i", "intent", "search", "settings", "share", "login", "logout",
  "signup", "tos", "privacy", "compose", "hashtag", "about", "jobs"]);
const TELEGRAM_RESERVED = new Set(["joinchat", "addstickers", "addemoji", "addlist", "addtheme", "setlanguage", "share", "proxy", "socks",
  "login", "boost", "confirmphone", "contact", "invoice", "giftcode"]);

const MESSAGES = {
  MAIN_TOKEN_IS_LEGACY_MINT: "MAIN_TOKEN_MINT is a legacy mint ($VICINITY); the main token must be the new mint the owner supplies",
  MAIN_TOKEN_MINT_INVALID: "MAIN_TOKEN_MINT must be a base58 32-byte public key, and not the all-zero default key",
  OFFICIAL_X_URL_INVALID: "OFFICIAL_X_URL must be https://x.com/<handle> with a handle of 1 to 15 characters from A-Z, a-z, 0-9 and _ (twitter.com is accepted and normalized)",
  OFFICIAL_TELEGRAM_URL_INVALID: "OFFICIAL_TELEGRAM_URL must be https://t.me/<name> with a name of 5 to 32 characters from A-Z, a-z, 0-9 and _",
  LEGACY_SOCIAL_LINK_AS_OFFICIAL: "OFFICIAL_X_URL is the legacy X account; the official link must be the new account the owner supplies",
};

/** One configuration value: undefined, null and blank text mean "not set"; text is trimmed; any other type is malformed. */
function configValue(raw) {
  if (raw === undefined || raw === null) return { set: false, text: null };
  if (typeof raw !== "string") return { set: true, text: null };
  const text = raw.trim();
  return text === "" ? { set: false, text: null } : { set: true, text };
}
const envValue = (env, key) => (env !== null && typeof env === "object" ? env[key] : undefined);

/** The all-zero key (the System Program address, Solana's default key): a common "none" placeholder, never a token mint. */
const DEFAULT_PUBLIC_KEY = "11111111111111111111111111111111";

/** { set, value, code }: value is the usable mint or null; code names why a set value is refused. */
function readMainTokenMint(raw) {
  const v = configValue(raw);
  if (!v.set) return { set: false, value: null, code: null };
  if (v.text !== null && LEGACY_MINTS.includes(v.text)) return { set: true, value: null, code: "MAIN_TOKEN_IS_LEGACY_MINT" };
  if (v.text === null || !isPublicKey(v.text) || v.text === DEFAULT_PUBLIC_KEY) return { set: true, value: null, code: "MAIN_TOKEN_MINT_INVALID" };
  return { set: true, value: v.text, code: null };
}

/** { set, value, code } for OFFICIAL_X_URL; the value is normalized to https://x.com/<handle>. */
function readXUrl(raw) {
  const v = configValue(raw);
  if (!v.set) return { set: false, value: null, code: null };
  const m = v.text === null ? null : /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(v.text);
  if (!m || X_RESERVED.has(m[1].toLowerCase())) return { set: true, value: null, code: "OFFICIAL_X_URL_INVALID" };
  if (LEGACY_X_HANDLES.includes(m[1].toLowerCase())) return { set: true, value: null, code: "LEGACY_SOCIAL_LINK_AS_OFFICIAL" };
  return { set: true, value: `https://x.com/${m[1]}`, code: null };
}

/** { set, value, code } for OFFICIAL_TELEGRAM_URL; the value is normalized to https://t.me/<name>. */
function readTelegramUrl(raw) {
  const v = configValue(raw);
  if (!v.set) return { set: false, value: null, code: null };
  const m = v.text === null ? null : /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\/?$/i.exec(v.text);
  if (!m || TELEGRAM_RESERVED.has(m[1].toLowerCase())) return { set: true, value: null, code: "OFFICIAL_TELEGRAM_URL_INVALID" };
  return { set: true, value: `https://t.me/${m[1]}`, code: null };
}

/**
 * The main token as configured: { configKey, mint, problem }. `mint` is null when MAIN_TOKEN_MINT is unset, malformed or a legacy
 * mint, so a consumer can never pick up an unusable or legacy value; `problem` then names the refusal (null when merely unset).
 * A non-null mint has the right shape only: it must also have passed the on-chain verification before it was configured.
 */
export function mainTokenConfig(env) {
  const r = readMainTokenMint(envValue(env, "MAIN_TOKEN_MINT"));
  return Object.freeze({ configKey: P.main_token.config_key, mint: r.value, problem: r.code });
}

/**
 * The official links as configured: { xUrl, telegramUrl, configKeys, problems }. Each link is normalized, or null when unset or
 * refused (the legacy X account is refused as an official link). Empty means not shown.
 */
export function officialLinks(env) {
  const keys = P.official_links.config_keys;
  const x = readXUrl(envValue(env, keys.x_url));
  const t = readTelegramUrl(envValue(env, keys.telegram_url));
  return Object.freeze({
    xUrl: x.value,
    telegramUrl: t.value,
    configKeys: Object.freeze({ xUrl: keys.x_url, telegramUrl: keys.telegram_url }),
    problems: Object.freeze({ xUrl: x.code, telegramUrl: t.code }),
  });
}

/**
 * The three amendment-01 values against the features that need the main token. `needs` lists those features in words (for the
 * message); `pathOf` maps a key to the error path. Returns the usable main-token mint or null.
 */
function checkTokenAndLinks(values, needs, add, pathOf) {
  const m = readMainTokenMint(values.MAIN_TOKEN_MINT);
  if (m.code) add(m.code, pathOf("MAIN_TOKEN_MINT"), MESSAGES[m.code]);
  else if (!m.set && needs.length > 0) {
    add("MAIN_TOKEN_MINT_MISSING", pathOf("MAIN_TOKEN_MINT"), `MAIN_TOKEN_MINT is required by ${needs.join(", ")}; the owner supplies the new mint and it is verified on chain before it is configured`);
  }
  const x = readXUrl(values.OFFICIAL_X_URL);
  if (x.code) add(x.code, pathOf("OFFICIAL_X_URL"), MESSAGES[x.code]);
  const t = readTelegramUrl(values.OFFICIAL_TELEGRAM_URL);
  if (t.code) add(t.code, pathOf("OFFICIAL_TELEGRAM_URL"), MESSAGES[t.code]);
  return m.value;
}

/**
 * Configuration acceptance for amendment 01: { ok, errors }. `env` holds MAIN_TOKEN_MINT, OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL
 * (any of them may be unset). `features` lists the enabled features from MAIN_TOKEN_FEATURES, as an array of names or an object of
 * booleans. Unset values are accepted while no feature that needs them is enabled; an unset link is simply not shown.
 * Errors: MAIN_TOKEN_MINT_MISSING, MAIN_TOKEN_MINT_INVALID, MAIN_TOKEN_IS_LEGACY_MINT, OFFICIAL_X_URL_INVALID,
 * OFFICIAL_TELEGRAM_URL_INVALID, LEGACY_SOCIAL_LINK_AS_OFFICIAL, and FEATURE_UNKNOWN or FEATURES_INVALID for a bad `features`.
 */
export function validateDeploymentConfig(env, features = []) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  const unknown = (n) => add("FEATURE_UNKNOWN", `features.${String(n)}`, `${String(n)} is not one of ${MAIN_TOKEN_FEATURES.join(", ")}`);
  const needs = [];
  if (Array.isArray(features)) {
    for (const n of features) {
      if (typeof n !== "string" || !MAIN_TOKEN_FEATURES.includes(n)) unknown(n);
      else if (!needs.includes(n)) needs.push(n);
    }
  } else if (isPlainObject(features)) {
    for (const [k, v] of Object.entries(features)) {
      if (!MAIN_TOKEN_FEATURES.includes(k)) unknown(k);
      else if (typeof v !== "boolean") add("FEATURES_INVALID", `features.${k}`, `${k} must be true or false`);
      else if (v) needs.push(k);
    }
  } else add("FEATURES_INVALID", "features", "features must be a list of feature names or an object of booleans");
  checkTokenAndLinks({
    MAIN_TOKEN_MINT: envValue(env, "MAIN_TOKEN_MINT"),
    OFFICIAL_X_URL: envValue(env, P.official_links.config_keys.x_url),
    OFFICIAL_TELEGRAM_URL: envValue(env, P.official_links.config_keys.telegram_url),
  }, needs, add, (k) => `env.${k}`);
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ configuration acceptance (master section 16) */

/** Allowed values of each (proposed, not yet existing) switch; the first value is the default, which is today's behavior. */
export const FLAG_VALUES = deepFreeze({
  WALLET_ONLY: ["off", "on"],
  LEGACY_LINK: ["off", "on"],
  LEGACY_SEATS: ["on", "frozen"],
  SELECTION_V5: ["off", "shadow", "on"],
  FOUNDER_RECORD_CHAIN: ["off", "on"],
  ACTIVITY_POINTS: ["off", "shadow", "on"],
  MANAGER_APPS: ["off", "on"],
  METADATA_V5: ["off", "on"],
  LAUNCH_V5: ["off", "on"],
  LEGACY_LAUNCH: ["on", "off"],
  CC_TRADING: ["off", "on"],
  CC_HOURLY: ["off", "shadow", "on"],
  HOST_REDIRECT: ["off", "on"],
  PUBLIC_V5: ["off", "on"],
  MAIN_TOKEN_V5: ["off", "on"],
});
const ENVIRONMENTS = ["unset", "test", "preview", "production"];
const CLUSTERS = ["mainnet", "devnet", "localnet"];
const ROLE_INPUTS = ["governance_vault", "treasury", "keeper", "selection_publisher", "selection_verifier", "hourly_verifier_a", "hourly_verifier_b", "metadata_admin", "guardian"];
const ADDRESS_INPUTS = ["program_id", ...ROLE_INPUTS];
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MISSING_CODE = {
  program_id: "MISSING_PROGRAM_ID",
  cluster: "MISSING_CLUSTER",
  governance_vault: "MISSING_GOVERNANCE_VAULT",
  treasury: "MISSING_TREASURY",
  keeper: "MISSING_KEEPER",
  selection_publisher: "MISSING_SELECTION_PUBLISHER",
  selection_verifier: "MISSING_SELECTION_VERIFIER",
  hourly_verifier_a: "MISSING_HOURLY_VERIFIER_A",
  hourly_verifier_b: "MISSING_HOURLY_VERIFIER_B",
  metadata_admin: "MISSING_METADATA_ADMIN",
  guardian: "MISSING_GUARDIAN",
  SITE_ORIGIN: "MISSING_SITE_ORIGIN",
  SITE_ORIGINS: "MISSING_SITE_ORIGINS",
  LEGACY_LINK_UNTIL: "MISSING_LEGACY_LINK_UNTIL",
};

export class PolicyError extends Error {
  constructor(errors) {
    super(`policy rejected: ${errors.map((e) => e.code).join(", ")}`);
    this.name = "PolicyError";
    this.errors = errors;
  }
}

function leafPaths(obj, prefix) {
  if (isLeaf(obj)) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, `${prefix}.${k}`));
}
function valueAt(obj, path) {
  return path.split(".").slice(1).reduce((o, k) => (isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

const MASTER_LEAVES = leafPaths(P, "policy");
function checkValues(candidate, add) {
  for (const path of MASTER_LEAVES) {
    if (!deepEqual(valueAt(P, path), valueAt(candidate, path))) add("POLICY_VALUE_MISMATCH", path, `${path} differs from the master value`);
  }
  for (const path of leafPaths(candidate, "policy")) {
    if (valueAt(P, path) === undefined && !MASTER_LEAVES.some((p) => path.startsWith(`${p}.`))) add("POLICY_KEY_UNKNOWN", path, `${path} is not a master policy value`);
  }
}

function decimalToRaw(text, decimals) {
  if (typeof text !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  const [i, f = ""] = text.split(".");
  if (f.length > decimals) return null;
  return BigInt(i + f.padEnd(decimals, "0"));
}

function checkInvariants(c, add) {
  const safe = (fn) => { try { fn(); } catch { /* structure already reported as a value mismatch */ } };
  safe(() => {
    const t = c.trading;
    const s = t.split_bps;
    if (s.liquidity + s.platform + s.founder + s.holders + s.buyback !== t.total_fee_bps) add("FEE_SPLIT_SUM", "policy.trading.split_bps", "the five shares must add up to total_fee_bps");
    if (25 * s.buyback > 3 * t.total_fee_bps) add("BUYBACK_THROUGHPUT", "policy.trading.split_bps.buyback", "25 * buyback_bps must be at most 3 * total_fee_bps");
  });
  safe(() => {
    const f = c.platform_fees;
    for (const k of ["launch_fee", "send_fee", "receive_fee"]) if (f[k] !== 0) add("PLATFORM_FEE_NOT_ZERO", `policy.platform_fees.${k}`, `${k} must be 0`);
  });
  safe(() => {
    if (c.founder_selection.cycle_seconds * 4 !== 86400) add("SELECTION_CYCLE", "policy.founder_selection.cycle_seconds", "four cycles must fill one UTC day (00, 06, 12, 18)");
    if (c.distribution.samples_per_hour * c.distribution.sample_segment_seconds !== c.distribution.hour_seconds) add("SAMPLE_SEGMENTS", "policy.distribution", "the sample segments must fill the hour");
  });
  safe(() => {
    const a = c.activity;
    const caps = Object.values(a.categories).reduce((s, x) => s + x.cap, 0);
    if (caps !== a.max_total) add("ACTIVITY_CAPS_SUM", "policy.activity.categories", "the category caps must add up to max_total");
    if (a.threshold > a.max_total) add("ACTIVITY_THRESHOLD", "policy.activity.threshold", "the threshold must be reachable");
    if (c.country_manager.min_valid_activity_points !== a.threshold) add("ACTIVITY_THRESHOLD", "policy.country_manager.min_valid_activity_points", "the manager threshold must equal the activity threshold");
  });
  for (const [id, q] of Object.entries((c && c.quote_configs) || {})) {
    safe(() => {
      const base = `policy.quote_configs.${id}`;
      const raw = (k) => BigInt(q[k].raw);
      if (raw("preburn_supply") !== raw("curve_tokens") + raw("pool_allocation") + raw("launch_burn")) add("CURVE_SUPPLY_SUM", base, "preburn supply must equal curve + pool + burn");
      const pairs = [["preburn_supply", "tokens", q.token_decimals], ["curve_tokens", "tokens", q.token_decimals], ["pool_allocation", "tokens", q.token_decimals],
        ["launch_burn", "tokens", q.token_decimals], ["graduation", "quote", q.quote_decimals], ["min_buy", "quote", q.quote_decimals],
        ["virtual_quote_reserve", "quote", q.quote_decimals], ["virtual_token_reserve", "tokens", q.token_decimals]];
      for (const [k, unit, dec] of pairs) {
        // amendment 01: the main-token quote's decimals and raw amounts are null until its configured mint is verified
        if (q[k] === null || q[k].raw === null || dec === null) continue;
        if (decimalToRaw(q[k][unit], dec) !== BigInt(q[k].raw)) add("QUOTE_UNITS", `${base}.${k}`, `${k}.raw must equal ${k}.${unit} at ${dec} decimals`);
      }
      const positive = (k) => (q[k].raw !== null ? BigInt(q[k].raw) > 0n : decimalToRaw(q[k].quote, 18) !== null && decimalToRaw(q[k].quote, 18) > 0n);
      if (!positive("graduation") || !positive("min_buy")) add("QUOTE_NOT_POSITIVE", base, "graduation and minimum buy must be positive");
    });
  }
  // amendment 01: a legacy mint is never the main token or the main-token quote
  safe(() => {
    const legacy = new Set([...LEGACY_MINTS, ...(Array.isArray(c.legacy_tokens) ? c.legacy_tokens.map((t) => t && t.mint) : [])].filter(Boolean));
    if (isPlainObject(c.main_token) && c.main_token.mint !== null && legacy.has(c.main_token.mint)) {
      add("MAIN_TOKEN_IS_LEGACY_MINT", "policy.main_token.mint", "the main token must not be a legacy mint");
    }
    const q = c.quote_configs && c.quote_configs.main_token;
    if (isPlainObject(q) && q.quote_mint !== null && legacy.has(q.quote_mint)) {
      add("MAIN_TOKEN_IS_LEGACY_MINT", "policy.quote_configs.main_token.quote_mint", "the main-token quote must not be a legacy mint");
    }
  });
}

function isOrigin(s, environment) {
  if (typeof s !== "string") return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.origin !== s) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && environment !== "production" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

function checkDeployment(d, add) {
  if (!isPlainObject(d)) { add("DEPLOYMENT_MISSING", "deployment", "the deployment block is missing"); return; }
  const env = d.environment;
  if (!ENVIRONMENTS.includes(env)) add("ENVIRONMENT_INVALID", "deployment.environment", `environment must be one of ${ENVIRONMENTS.join(", ")}`);
  if (typeof d.fixture !== "boolean") add("FIXTURE_FLAG_INVALID", "deployment.fixture", "fixture must be true or false");
  if (d.fixture === true && env === "production") add("FIXTURE_IN_PRODUCTION", "deployment.fixture", "local test fixtures are refused in production");

  const flags = isPlainObject(d.flags) ? d.flags : {};
  if (!isPlainObject(d.flags)) add("FLAGS_MISSING", "deployment.flags", "the flags block is missing");
  for (const name of Object.keys(flags)) if (!Object.prototype.hasOwnProperty.call(FLAG_VALUES, name)) add("FLAG_UNKNOWN", `deployment.flags.${name}`, `${name} is not a known switch`);
  const f = {};
  for (const [name, values] of Object.entries(FLAG_VALUES)) {
    if (!Object.prototype.hasOwnProperty.call(flags, name)) { add("FLAG_MISSING", `deployment.flags.${name}`, `${name} must be set (default ${values[0]})`); f[name] = values[0]; continue; }
    if (!values.includes(flags[name])) { add("FLAG_VALUE_INVALID", `deployment.flags.${name}`, `${name} must be one of ${values.join(", ")}`); f[name] = values[0]; continue; }
    f[name] = flags[name];
  }
  const changed = Object.entries(FLAG_VALUES).some(([name, values]) => f[name] !== values[0]);
  if (env === "unset" && changed) add("ENVIRONMENT_UNSET", "deployment.environment", "a deployment that changes any switch must name its environment");

  const known = Object.keys(MASTER_POLICY.deployment.inputs);
  const inputs = isPlainObject(d.inputs) ? d.inputs : {};
  if (!isPlainObject(d.inputs)) add("INPUTS_MISSING", "deployment.inputs", "the inputs block is missing");
  for (const k of Object.keys(inputs)) if (!known.includes(k)) add("INPUT_UNKNOWN", `deployment.inputs.${k}`, `${k} is not a known deployment input`);
  const present = (k) => inputs[k] !== null && inputs[k] !== undefined && !(Array.isArray(inputs[k]) && inputs[k].length === 0);

  // shapes of whatever is present
  for (const k of ADDRESS_INPUTS) if (present(k) && !isPublicKey(inputs[k])) add("INPUT_NOT_A_PUBLIC_KEY", `deployment.inputs.${k}`, `${k} must be a base58 32-byte public key`);
  if (present("cluster") && !CLUSTERS.includes(inputs.cluster)) add("CLUSTER_INVALID", "deployment.inputs.cluster", `cluster must be one of ${CLUSTERS.join(", ")}`);
  if (present("SITE_ORIGINS") && (!Array.isArray(inputs.SITE_ORIGINS) || !inputs.SITE_ORIGINS.every((o) => isOrigin(o, env)))) add("SITE_ORIGINS_INVALID", "deployment.inputs.SITE_ORIGINS", "SITE_ORIGINS must be a list of bare https origins");
  if (present("SITE_ORIGIN")) {
    if (!isOrigin(inputs.SITE_ORIGIN, env)) add("SITE_ORIGIN_INVALID", "deployment.inputs.SITE_ORIGIN", "SITE_ORIGIN must be a bare https origin");
    else if (!Array.isArray(inputs.SITE_ORIGINS) || !inputs.SITE_ORIGINS.includes(inputs.SITE_ORIGIN)) add("SITE_ORIGIN_NOT_ALLOWED", "deployment.inputs.SITE_ORIGIN", "SITE_ORIGIN must be one of SITE_ORIGINS");
  }
  if (present("LEGACY_LINK_UNTIL") && !(typeof inputs.LEGACY_LINK_UNTIL === "string" && /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(inputs.LEGACY_LINK_UNTIL) && Number.isFinite(Date.parse(inputs.LEGACY_LINK_UNTIL)))) {
    add("LEGACY_LINK_UNTIL_INVALID", "deployment.inputs.LEGACY_LINK_UNTIL", "LEGACY_LINK_UNTIL must be an ISO 8601 date");
  }
  const roles = ROLE_INPUTS.filter(present);
  for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
    if (inputs[roles[i]] === inputs[roles[j]]) add(roles[i] === "treasury" || roles[j] === "treasury" ? "TREASURY_NOT_DEDICATED" : "ROLE_KEYS_NOT_DISTINCT",
      `deployment.inputs.${roles[j]}`, `${roles[i]} and ${roles[j]} must be different keys`);
  }

  // incompatible switches
  const on = (name) => f[name] === "on";
  const live = (name) => f[name] !== FLAG_VALUES[name][0];
  if (on("LEGACY_LINK") && !on("WALLET_ONLY")) add("LEGACY_LINK_WITHOUT_WALLET_ONLY", "deployment.flags.LEGACY_LINK", "the legacy link window exists only under wallet-only sign-in");
  if (on("SELECTION_V5") && !on("FOUNDER_RECORD_CHAIN")) add("SELECTION_ON_WITHOUT_CHAIN_RECORD", "deployment.flags.SELECTION_V5", "a permanent founder is recorded only after the on-chain FounderRecord exists");
  if (on("SELECTION_V5") && f.LEGACY_SEATS !== "frozen") add("SELECTION_ON_WITH_LEGACY_SEATS", "deployment.flags.LEGACY_SEATS", "the old seat, election and streak writers must be frozen first");
  if (on("MANAGER_APPS") && !on("SELECTION_V5")) add("MANAGER_APPS_WITHOUT_SELECTION", "deployment.flags.MANAGER_APPS", "manager applications need permanent founders");
  if (on("MANAGER_APPS") && !on("ACTIVITY_POINTS")) add("MANAGER_APPS_WITHOUT_POINTS", "deployment.flags.MANAGER_APPS", "manager applications need the activity ledger");
  if (on("LAUNCH_V5") && on("LEGACY_LAUNCH")) add("LAUNCH_V5_WITH_LEGACY_LAUNCH", "deployment.flags.LEGACY_LAUNCH", "new launches may run on one program only; turn legacy launches off");
  if (on("LAUNCH_V5") && !on("FOUNDER_RECORD_CHAIN")) add("LAUNCH_V5_WITHOUT_FOUNDER_RECORD", "deployment.flags.LAUNCH_V5", "self-service launch checks the on-chain FounderRecord");
  if (on("LAUNCH_V5") && !on("METADATA_V5")) add("LAUNCH_V5_WITHOUT_METADATA_V5", "deployment.flags.LAUNCH_V5", "self-service launch needs the protected defaults and the review lock");
  if (env === "production" && on("METADATA_V5") && !on("FOUNDER_RECORD_CHAIN")) add("METADATA_V5_PRODUCTION_WITHOUT_CHAIN", "deployment.flags.METADATA_V5", "in production a metadata decision completes only after its chain transition");
  if (on("HOST_REDIRECT") && present("SITE_ORIGIN") && inputs.SITE_ORIGIN !== P.pairs_and_branding.canonical_origin) add("HOST_REDIRECT_TARGET_NOT_CANONICAL", "deployment.inputs.SITE_ORIGIN", "old-host redirects must point at the canonical origin");

  const chainFlag = on("FOUNDER_RECORD_CHAIN") || on("LAUNCH_V5") || on("CC_TRADING") || live("CC_HOURLY");
  const moneyFlag = on("LAUNCH_V5") || on("CC_TRADING") || live("CC_HOURLY");
  if (env === "production" && chainFlag && present("cluster") && inputs.cluster !== "mainnet") add("CLUSTER_NOT_MAINNET_IN_PRODUCTION", "deployment.inputs.cluster", "production chain switches must use mainnet");
  if ((env === "test" || env === "preview") && moneyFlag && inputs.cluster === "mainnet") add("MAINNET_MONEY_FLAG_OUTSIDE_PRODUCTION", "deployment.inputs.cluster", "test and preview money paths must not use mainnet");

  // missing required inputs, one error per input naming every switch that needs it
  const need = new Map();
  const needs = (input, by) => { if (!need.has(input)) need.set(input, []); need.get(input).push(by); };
  if (on("WALLET_ONLY")) { needs("SITE_ORIGINS", "WALLET_ONLY=on"); needs("SITE_ORIGIN", "WALLET_ONLY=on"); }
  if (on("LEGACY_LINK")) needs("LEGACY_LINK_UNTIL", "LEGACY_LINK=on");
  if (on("HOST_REDIRECT")) needs("SITE_ORIGIN", "HOST_REDIRECT=on");
  if (on("FOUNDER_RECORD_CHAIN")) { needs("program_id", "FOUNDER_RECORD_CHAIN=on"); needs("cluster", "FOUNDER_RECORD_CHAIN=on"); }
  if (on("SELECTION_V5")) { needs("selection_publisher", "SELECTION_V5=on"); needs("selection_verifier", "SELECTION_V5=on"); }
  if (env === "production" && on("METADATA_V5")) { needs("metadata_admin", "METADATA_V5=on"); needs("program_id", "METADATA_V5=on"); needs("cluster", "METADATA_V5=on"); }
  if (on("LAUNCH_V5")) for (const k of ["program_id", "cluster", "treasury", "metadata_admin", "governance_vault", "guardian"]) needs(k, "LAUNCH_V5=on");
  if (on("CC_TRADING")) { needs("program_id", "CC_TRADING=on"); needs("cluster", "CC_TRADING=on"); }
  if (live("CC_HOURLY")) { needs("program_id", `CC_HOURLY=${f.CC_HOURLY}`); needs("cluster", `CC_HOURLY=${f.CC_HOURLY}`); }
  if (on("CC_HOURLY")) for (const k of ["treasury", "keeper", "hourly_verifier_a", "hourly_verifier_b"]) needs(k, "CC_HOURLY=on");
  for (const [input, by] of need) if (!present(input)) add(MISSING_CODE[input], `deployment.inputs.${input}`, `${input} is required by ${by.join(", ")}`);
  const secrets = isPlainObject(inputs.secrets_present) ? inputs.secrets_present : {};
  if (live("SELECTION_V5")) {
    if (secrets.SELECTION_ARCHIVE_URL_A !== true) add("MISSING_ARCHIVE_PROVIDER_A", "deployment.inputs.secrets_present.SELECTION_ARCHIVE_URL_A", "the selection snapshot needs historical provider A");
    if (secrets.SELECTION_ARCHIVE_URL_B !== true) add("MISSING_ARCHIVE_PROVIDER_B", "deployment.inputs.secrets_present.SELECTION_ARCHIVE_URL_B", "the selection snapshot needs an independent provider B");
  }

  // amendment 01: the main token, and the official links, come from configuration; every feature that reads the main token needs a
  // valid, non-legacy MAIN_TOKEN_MINT (the owner supplies it, and it is verified on chain before it is configured)
  const moneyQuotes = on("LAUNCH_V5") || on("CC_TRADING");
  const enabledQuotes = Array.isArray(inputs.enabled_quote_configs) ? inputs.enabled_quote_configs : [];
  const tokenNeeds = [];
  if (live("SELECTION_V5")) tokenNeeds.push(`founder selection (SELECTION_V5=${f.SELECTION_V5})`);
  if (on("MANAGER_APPS")) tokenNeeds.push("country-manager ranking (MANAGER_APPS=on)");
  if (on("MAIN_TOKEN_V5")) tokenNeeds.push("the token page and purchase links (MAIN_TOKEN_V5=on)");
  if (moneyQuotes && enabledQuotes.includes("main_token")) tokenNeeds.push("the main-token quote (enabled_quote_configs)");
  const mainMint = checkTokenAndLinks(inputs, tokenNeeds, add, (k) => `deployment.inputs.${k}`);

  // quote configs that a money path would offer
  if (moneyQuotes) {
    const enabled = enabledQuotes;
    if (enabled.length === 0) add("NO_ENABLED_QUOTE_CONFIG", "deployment.inputs.enabled_quote_configs", "at least one approved quote config must be enabled");
    const facts = isPlainObject(inputs.quote_mint_facts) ? inputs.quote_mint_facts : {};
    for (const id of enabled) {
      const path = `deployment.inputs.enabled_quote_configs.${id}`;
      const cfg = Object.prototype.hasOwnProperty.call(P.quote_configs, id) ? P.quote_configs[id] : null;
      if (!cfg) { add("QUOTE_CONFIG_UNKNOWN", path, `${id} is not an approved quote config`); continue; }
      // the main-token quote's mint is the configured main token (amendment 01); without a usable one it was refused above
      const quoteMint = id === "main_token" ? mainMint : cfg.quote_mint;
      if (!quoteMint) continue;
      const fact = Object.prototype.hasOwnProperty.call(facts, quoteMint) ? facts[quoteMint] : null;
      if (!isPlainObject(fact)) { add("QUOTE_FACTS_MISSING", `deployment.inputs.quote_mint_facts.${quoteMint}`, `read ${id}'s mint from the chain before enabling it`); continue; }
      if (fact.token_program !== CLASSIC_TOKEN_PROGRAM) add("QUOTE_TOKEN_PROGRAM", path, `${id} must be a classic SPL Token mint (Token-2022 is unavailable)`);
      if (cfg.quote_decimals !== null ? fact.decimals !== cfg.quote_decimals : !(Number.isInteger(fact.decimals) && fact.decimals >= 0 && fact.decimals <= 255)) {
        add("QUOTE_DECIMALS", path, cfg.quote_decimals !== null ? `${id} decimals on chain must equal ${cfg.quote_decimals}` : `${id} decimals must be read from the chain (an integer from 0 to 255)`);
      }
      if (cfg.requires_revoked_mint_and_freeze_authority) {
        if (fact.mint_authority !== null) add("QUOTE_MINT_AUTHORITY", path, `${id} must have no mint authority`);
        if (fact.freeze_authority !== null) add("QUOTE_FREEZE_AUTHORITY", path, `${id} must have no freeze authority`);
      }
    }
  }
}

/**
 * Configuration acceptance: { ok, errors }. Every error has a stable `code`, the `path` it concerns and a plain `message`.
 * Validating the frozen MASTER_POLICY itself returns ok (every switch at its default, nothing required).
 */
export function validatePolicy(policy) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!isPlainObject(policy)) {
    add("POLICY_NOT_OBJECT", "", "the policy must be an object");
    return { ok: false, errors };
  }
  if (policy.policy_version !== MASTER_POLICY.policy_version) add("POLICY_VERSION_MISMATCH", "policy_version", `policy_version must be ${MASTER_POLICY.policy_version}`);
  if (policy.owner_delegation_date !== MASTER_POLICY.owner_delegation_date) add("OWNER_DELEGATION_DATE_MISMATCH", "owner_delegation_date", `owner_delegation_date must be ${MASTER_POLICY.owner_delegation_date}`);
  if (!isPlainObject(policy.policy)) add("POLICY_VALUES_MISSING", "policy", "the policy values are missing");
  else {
    checkValues(policy.policy, add);
    checkInvariants(policy.policy, add);
  }
  checkDeployment(policy.deployment, add);
  return { ok: errors.length === 0, errors };
}

export function assertValidPolicy(policy) {
  const r = validatePolicy(policy);
  if (!r.ok) throw new PolicyError(r.errors);
  return policy;
}

/** An unfrozen copy of `policy` whose deployment environment, fixture, flags and inputs are overridden (flags and inputs merge). */
export function withDeployment(policy, overrides = {}) {
  const copy = clone(policy);
  const d = isPlainObject(copy.deployment) ? copy.deployment : (copy.deployment = {});
  if (Object.prototype.hasOwnProperty.call(overrides, "environment")) d.environment = overrides.environment;
  if (Object.prototype.hasOwnProperty.call(overrides, "fixture")) d.fixture = overrides.fixture;
  if (isPlainObject(overrides.flags)) d.flags = { ...(isPlainObject(d.flags) ? d.flags : {}), ...clone(overrides.flags) };
  if (isPlainObject(overrides.inputs)) {
    const base = isPlainObject(d.inputs) ? d.inputs : {};
    const next = { ...base, ...clone(overrides.inputs) };
    if (isPlainObject(overrides.inputs.secrets_present)) next.secrets_present = { ...(isPlainObject(base.secrets_present) ? base.secrets_present : {}), ...overrides.inputs.secrets_present };
    d.inputs = next;
  }
  return copy;
}
