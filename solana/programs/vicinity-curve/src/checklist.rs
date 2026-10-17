//! Review checklist tests (test-only module).
//!
//! Two kinds of check that no unit test of a single function can make:
//!
//! * **Source rules** read the instruction files as text: the halt-all guard
//!   tops exactly the eight outflow handlers (4.0, 8.3); lamports leave a
//!   `Coin` only through `custody::pay_out`, in exactly the five debits of 6.5,
//!   after the bookkeeping, and only the event CPI follows it (rule of 4.0);
//!   money instructions emit by event CPI and settings instructions by `emit!`
//!   (4.21, M20); no `init_if_needed`, no remaining accounts, no token
//!   approve, close, freeze or thaw, and `mint_to` / `set_authority` only in
//!   `launch` (T29, T30, T41, I14).
//! * **The instruction contract** of section 4 against the committed client
//!   IDL `sdk/idl/vicinity_curve.json` (generated from this crate with the
//!   `idl-build` feature; CI diffs it against the build): every instruction's
//!   accounts in the order, with the signer and writable flags, of its table,
//!   its arguments, the account discriminators, the 21 events, the 54 error
//!   codes and the compiled ids of the default (mainnet) build.

use serde_json::{json, Value};

/// Every instruction file, by instruction name.
const SOURCES: [(&str, &str); 21] = [
    ("accept_admin", include_str!("instructions/accept_admin.rs")),
    (
        "add_launch_config",
        include_str!("instructions/add_launch_config.rs"),
    ),
    (
        "approve_launch",
        include_str!("instructions/approve_launch.rs"),
    ),
    ("buy", include_str!("instructions/buy.rs")),
    ("buyback_burn", include_str!("instructions/buyback_burn.rs")),
    (
        "claim_founder_fees",
        include_str!("instructions/claim_founder_fees.rs"),
    ),
    (
        "forward_holders_fees",
        include_str!("instructions/forward_holders_fees.rs"),
    ),
    (
        "init_launchpad",
        include_str!("instructions/init_launchpad.rs"),
    ),
    ("launch", include_str!("instructions/launch.rs")),
    (
        "opt_in_payout",
        include_str!("instructions/opt_in_payout.rs"),
    ),
    (
        "payout_founder_fees",
        include_str!("instructions/payout_founder_fees.rs"),
    ),
    (
        "propose_admin",
        include_str!("instructions/propose_admin.rs"),
    ),
    (
        "revoke_approval",
        include_str!("instructions/revoke_approval.rs"),
    ),
    (
        "revoke_payout_opt_in",
        include_str!("instructions/revoke_payout_opt_in.rs"),
    ),
    ("sell", include_str!("instructions/sell.rs")),
    ("set_guardian", include_str!("instructions/set_guardian.rs")),
    (
        "set_launch_config_enabled",
        include_str!("instructions/set_launch_config_enabled.rs"),
    ),
    ("set_pause", include_str!("instructions/set_pause.rs")),
    (
        "set_payout_config",
        include_str!("instructions/set_payout_config.rs"),
    ),
    (
        "transfer_founder",
        include_str!("instructions/transfer_founder.rs"),
    ),
    (
        "withdraw_platform_fees",
        include_str!("instructions/withdraw_platform_fees.rs"),
    ),
];

/// The other source files of the crate (non-test parts are checked).
const OTHER_SOURCES: [(&str, &str); 7] = [
    ("lib.rs", include_str!("lib.rs")),
    ("constants.rs", include_str!("constants.rs")),
    ("custody.rs", include_str!("custody.rs")),
    ("errors.rs", include_str!("errors.rs")),
    ("events.rs", include_str!("events.rs")),
    ("helpers.rs", include_str!("helpers.rs")),
    ("state.rs", include_str!("state.rs")),
];

/// 4.0 and 8.3: the eight handlers that move lamports or tokens out of a
/// `Coin` or its vault.
const OUTFLOWS: [&str; 8] = [
    "launch",
    "buy",
    "sell",
    "buyback_burn",
    "withdraw_platform_fees",
    "forward_holders_fees",
    "claim_founder_fees",
    "payout_founder_fees",
];

/// 6.5: the users of the single debit helper.
const DEBITS: [&str; 5] = [
    "sell",
    "withdraw_platform_fees",
    "forward_holders_fees",
    "claim_founder_fees",
    "payout_founder_fees",
];

/// The part of a source file before its `#[cfg(test)]` module, if any.
fn code_part(src: &str) -> &str {
    match src.find("#[cfg(test)]") {
        Some(at) => &src[..at],
        None => src,
    }
}

/// The body of `pub fn handle_<name>(...)`, from its opening brace.
fn handler_body<'a>(name: &str, src: &'a str) -> &'a str {
    let sig = format!("pub fn handle_{name}(");
    let at = src
        .find(&sig)
        .unwrap_or_else(|| panic!("{name}: no `{sig}`"));
    let open = at + src[at..].find('{').expect("body");
    &src[open + 1..]
}

/// The first statement of the handler body.
fn first_statement<'a>(name: &str, src: &'a str) -> &'a str {
    handler_body(name, src)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("//"))
        .expect("statement")
}

#[test]
fn every_instruction_file_has_its_handler() {
    for (name, src) in SOURCES {
        assert!(
            src.contains(&format!("pub fn handle_{name}(")),
            "{name}: one file per instruction, handle_<name> (3.1)"
        );
    }
}

/// 4.0, 8.3: `require_not_halted()?` is the first statement of exactly the
/// eight outflow handlers, and appears nowhere else.
#[test]
fn halt_all_guard_tops_exactly_the_eight_outflows() {
    for (name, src) in SOURCES {
        if OUTFLOWS.contains(&name) {
            assert_eq!(
                first_statement(name, src),
                "require_not_halted()?;",
                "{name}: the halt-all guard must come before anything else"
            );
            assert_eq!(src.matches("require_not_halted()?").count(), 1, "{name}");
        } else {
            assert!(
                !src.contains("require_not_halted"),
                "{name}: not an outflow instruction (8.3)"
            );
        }
    }
}

/// 6.5 and the rule of 4.0: lamports leave a `Coin` only through `pay_out`,
/// called once by each of the five debits, after the bookkeeping (it reads
/// `liabilities()` of the updated state), and no CPI but the event CPI
/// follows it.
#[test]
fn single_debit_helper_and_the_rule_of_4_0() {
    let cpi_markers = [
        "CpiContext",
        "invoke",
        "token::",
        "system_program::",
        "sync_native",
        "with_coin_signer",
    ];
    for (name, src) in SOURCES {
        let body = handler_body(name, src);
        let calls = body.matches("pay_out(").count();
        if DEBITS.contains(&name) {
            assert_eq!(calls, 1, "{name}: one debit");
            let at = body.find("pay_out(").unwrap();
            let (before, after) = (&body[..at], &body[at..]);
            assert!(
                before.contains(".liabilities()?"),
                "{name}: liabilities_after comes from the updated state"
            );
            for m in cpi_markers {
                assert!(
                    !after.contains(m),
                    "{name}: `{m}` after the lamport move breaks the rule of 4.0"
                );
            }
            assert!(after.contains("emit_cpi!("), "{name}: event after the move");
        } else {
            assert_eq!(calls, 0, "{name}: no lamport leaves a Coin here");
        }
        // No instruction moves lamports by hand.
        for m in [
            "try_borrow_mut_lamports",
            "lamports.borrow_mut",
            "sub_lamports",
            "add_lamports",
        ] {
            assert!(!src.contains(m), "{name}: `{m}` outside custody.rs");
        }
    }
    // custody.rs writes exactly two balances (the Coin and the destination),
    // in one function; no other module writes lamports.
    for (file, src) in OTHER_SOURCES {
        let n = code_part(src).matches("try_borrow_mut_lamports").count();
        let want = if file == "custody.rs" { 2 } else { 0 };
        assert_eq!(n, want, "{file}");
    }
}

/// 4.0, 4.21, M20: instructions that move money or tokens emit by event CPI
/// (`#[event_cpi]` accounts, `emit_cpi!`); settings instructions by `emit!`.
/// Every instruction emits.
#[test]
fn money_events_by_cpi_settings_by_emit() {
    for (name, src) in SOURCES {
        let body = handler_body(name, src);
        if OUTFLOWS.contains(&name) {
            assert!(src.contains("#[event_cpi]"), "{name}");
            assert!(body.contains("emit_cpi!("), "{name}");
            assert!(!body.contains("emit!("), "{name}");
        } else {
            assert!(!src.contains("#[event_cpi]"), "{name}");
            assert!(!body.contains("emit_cpi!("), "{name}");
            assert!(body.contains("emit!("), "{name}");
        }
    }
}

/// T29, T30, T41, I14: plain `init` only; no remaining accounts; no token
/// approve, close, freeze or thaw anywhere; the mint is minted and its
/// authority removed only in `launch`; coins leave the vault only by
/// `transfer_checked` in `buy` and by `burn` in `buyback_burn` and the launch
/// burn; lamports come in only by the system transfers of `buy` and the
/// launch fee.
#[test]
fn token_and_account_surface() {
    let all = SOURCES.iter().chain(OTHER_SOURCES.iter());
    for (name, src) in all {
        let code = code_part(src);
        for banned in [
            "init_if_needed",
            "remaining_accounts",
            "close_account",
            "freeze_account",
            "thaw_account",
            "token::approve",
            "token::revoke",
            "realloc(",
            "Token2022",
            "token_interface",
            "AssociatedToken",
        ] {
            assert!(!code.contains(banned), "{name}: `{banned}`");
        }
    }
    let only_in = |what: &str, allowed: &[&str]| {
        for (name, src) in SOURCES {
            assert_eq!(
                src.contains(what),
                allowed.contains(&name),
                "`{what}` in {name}"
            );
        }
    };
    only_in("token::mint_to(", &["launch"]);
    only_in("token::set_authority(", &["launch"]);
    only_in("token::burn(", &["launch", "buyback_burn"]);
    only_in("token::transfer_checked(", &["buy", "sell"]);
    only_in("system_program::transfer(", &["launch", "buy"]);
    only_in("create_metadata_accounts_v3(", &["launch"]);
    only_in(
        "close = ",
        &["revoke_approval", "launch", "revoke_payout_opt_in"],
    );
}

/// The source without comment lines (`//`, `///`, `//!`), so that rules
/// match code only.
fn without_comments(src: &str) -> String {
    src.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The instructions whose code mentions `what`.
fn mentioned_in(what: &str) -> Vec<&'static str> {
    SOURCES
        .iter()
        .filter(|(_, src)| without_comments(src).contains(what))
        .map(|(name, _)| *name)
        .collect()
}

/// 4.4, 8.3, 3.4: who reads and writes the pause flags and the keys of
/// `Launchpad`. `buys_halted` stops only `launch` and `buy`;
/// `buybacks_halted` only `buyback_burn` (review LL-1);
/// `launches_paused` only `launch`; `payouts_paused` only
/// `payout_founder_fees`. No exit (sell, claim, forward, withdraw) reads any
/// flag. The flags are written only by `init_launchpad` (all false) and
/// `set_pause`; the payout key and wallet only by `init_launchpad` (zero: off
/// by default, O12) and `set_payout_config`; the guardian only by
/// `init_launchpad` and `set_guardian`; the admin seat only by
/// `init_launchpad`, `propose_admin` and `accept_admin`.
#[test]
fn pause_flags_and_launchpad_keys() {
    let want = |what: &str, mut names: Vec<&str>| {
        let mut got = mentioned_in(what);
        got.sort_unstable();
        names.sort_unstable();
        assert_eq!(got, names, "`{what}`");
    };
    want(
        ".buys_halted",
        vec!["buy", "launch", "init_launchpad", "set_pause"],
    );
    want(
        ".buybacks_halted",
        vec!["buyback_burn", "init_launchpad", "set_pause"],
    );
    want(
        ".launches_paused",
        vec!["launch", "init_launchpad", "set_pause"],
    );
    want(
        ".payouts_paused",
        vec!["payout_founder_fees", "init_launchpad", "set_pause"],
    );
    want(
        ".payout_authority =",
        vec!["init_launchpad", "set_payout_config"],
    );
    want(
        ".payout_destination =",
        vec!["init_launchpad", "set_payout_config"],
    );
    want(".guardian =", vec!["init_launchpad", "set_guardian"]);
    want(".admin =", vec!["init_launchpad", "accept_admin"]);
    want(
        ".pending_admin =",
        vec!["init_launchpad", "propose_admin", "accept_admin"],
    );
    // Payouts start off: init writes both payout settings as zero.
    let init = without_comments(
        SOURCES
            .iter()
            .find(|(n, _)| *n == "init_launchpad")
            .unwrap()
            .1,
    );
    assert!(init.contains("lp.payout_authority = Pubkey::default();"));
    assert!(init.contains("lp.payout_destination = Pubkey::default();"));
    // The exits never take a typed Launchpad: sell checks its address only.
    let sell = SOURCES.iter().find(|(n, _)| *n == "sell").unwrap().1;
    assert!(sell.contains("pub launchpad: UncheckedAccount<'info>"));
}

/// R2-DIFF-1, SPEC-1: every instruction that names a founder checks the seat
/// (`check_founder_key`: never zero, `FEE_RECIPIENT`, the guardian or the
/// payout key): `approve_launch` the founder it names, `launch` the signing
/// founder again, `transfer_founder` the new founder. No other instruction
/// writes or names a founder.
#[test]
fn founder_seat_checked_wherever_a_founder_is_named() {
    let mut got = mentioned_in("check_founder_key(");
    got.sort_unstable();
    assert_eq!(got, ["approve_launch", "launch", "transfer_founder"]);
    assert_eq!(mentioned_in("a.founder = founder"), ["approve_launch"]);
}

/// I1, I2, R4: the frozen terms and identity of a `Coin` are written once, in
/// `launch`, and never again; the phase changes only through the math crate's
/// state (`apply_state`); the founder only in `transfer_founder`; the
/// graduation fields only in the graduating `buy`.
#[test]
fn frozen_coin_fields_are_written_only_at_launch() {
    let frozen = [
        "layout_version",
        "bump",
        "mint_bump",
        "vault_bump",
        "config_id",
        "city_id",
        "mint",
        "vault",
        "symbol",
        "liquidity_bps",
        "platform_bps",
        "founder_bps",
        "holders_bps",
        "buyback_bps",
        "total_fee_bps",
        "virtual_sol",
        "virtual_tokens",
        "curve_supply",
        "pool_supply",
        "graduation_sol",
        "dust_burned",
        "meta_hash",
        "rent_reserve",
        "launched_at",
        "launch_slot",
    ];
    let launch = without_comments(SOURCES.iter().find(|(n, _)| *n == "launch").unwrap().1);
    for field in frozen {
        assert!(
            mentioned_in(&format!("coin.{field} =")).is_empty(),
            "coin.{field} is frozen after launch"
        );
        assert_eq!(
            launch.matches(&format!("c.{field} = ")).count(),
            1,
            "launch writes {field} once"
        );
    }
    assert!(mentioned_in("coin.phase =").is_empty());
    assert!(mentioned_in("c.phase =").is_empty());
    assert_eq!(mentioned_in("coin.founder ="), ["transfer_founder"]);
    assert_eq!(mentioned_in("coin.graduated_at ="), ["buy"]);
    assert_eq!(mentioned_in("coin.graduation_slot ="), ["buy"]);
}

// ---- the instruction contract of section 4, against the committed IDL ----

fn idl() -> Value {
    let path = format!(
        "{}/../../sdk/idl/vicinity_curve.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap()
}

const S: u8 = 1;
const W: u8 = 2;
const SW: u8 = S | W;
const EVENT_ACCOUNTS: [(&str, u8); 2] = [("event_authority", 0), ("program", 0)];

/// The account tables of section 4: name and S/W flags, in order. Instructions
/// with `#[event_cpi]` end with the two event accounts (4.0).
fn spec_accounts() -> Vec<(&'static str, Vec<(&'static str, u8)>)> {
    let trade = vec![
        ("user", SW),
        ("coin", W),
        ("launchpad", 0),
        ("mint", 0),
        ("coin_vault", W),
        ("user_token_account", W),
        ("token_program", 0),
        ("system_program", 0),
    ];
    let with_events = |mut v: Vec<(&'static str, u8)>| {
        v.extend(EVENT_ACCOUNTS);
        v
    };
    vec![
        (
            "init_launchpad",
            vec![
                ("payer", SW),
                ("admin", S),
                ("upgrade_authority", S),
                ("program_data", 0),
                ("launchpad", W),
                ("system_program", 0),
            ],
        ),
        ("propose_admin", vec![("admin", S), ("launchpad", W)]),
        ("accept_admin", vec![("new_admin", S), ("launchpad", W)]),
        ("set_pause", vec![("authority", S), ("launchpad", W)]),
        ("set_guardian", vec![("admin", S), ("launchpad", W)]),
        ("set_payout_config", vec![("admin", S), ("launchpad", W)]),
        (
            "add_launch_config",
            vec![
                ("admin", S),
                ("payer", SW),
                ("launchpad", W),
                ("config", W),
                ("system_program", 0),
            ],
        ),
        (
            "set_launch_config_enabled",
            vec![("admin", S), ("launchpad", 0), ("config", W)],
        ),
        (
            "approve_launch",
            vec![
                ("admin", SW),
                ("launchpad", 0),
                ("config", 0),
                ("approval", W),
                ("coin", 0),
                ("ticker_lock", 0),
                ("legacy_coin", 0),
                ("legacy_approval", 0),
                ("legacy_launchpad", 0),
                ("system_program", 0),
            ],
        ),
        (
            "revoke_approval",
            vec![
                ("by", S),
                ("launchpad", 0),
                ("approval", W),
                ("rent_payer", W),
            ],
        ),
        (
            "launch",
            with_events(vec![
                ("founder", S),
                ("payer", SW),
                ("launchpad", 0),
                ("approval", W),
                ("rent_payer", W),
                ("config", 0),
                ("coin", W),
                ("mint", W),
                ("coin_vault", W),
                ("ticker_lock", W),
                ("metadata", W),
                ("fee_recipient", W),
                ("legacy_coin", 0),
                ("legacy_approval", 0),
                ("legacy_launchpad", 0),
                ("metadata_program", 0),
                ("token_program", 0),
                ("system_program", 0),
                ("rent", 0),
            ]),
        ),
        ("buy", with_events(trade.clone())),
        ("sell", with_events(trade)),
        (
            "buyback_burn",
            with_events(vec![
                ("coin", W),
                ("launchpad", 0),
                ("mint", W),
                ("coin_vault", W),
                ("token_program", 0),
            ]),
        ),
        (
            "withdraw_platform_fees",
            with_events(vec![("coin", W), ("fee_recipient", W)]),
        ),
        (
            "forward_holders_fees",
            with_events(vec![
                ("launchpad", 0),
                ("coin", W),
                ("rewards_city_config", 0),
                ("rewards_vault", W),
            ]),
        ),
        (
            "claim_founder_fees",
            with_events(vec![("founder", SW), ("coin", W)]),
        ),
        (
            "transfer_founder",
            vec![
                ("founder", S),
                ("new_founder", S),
                ("launchpad", 0),
                ("coin", W),
            ],
        ),
        (
            "opt_in_payout",
            vec![
                ("founder", SW),
                ("launchpad", 0),
                ("coin", 0),
                ("opt_in", W),
                ("system_program", 0),
            ],
        ),
        (
            "revoke_payout_opt_in",
            vec![("by", S), ("coin", 0), ("opt_in", W), ("opt_in_founder", W)],
        ),
        (
            "payout_founder_fees",
            with_events(vec![
                ("payout_authority", S),
                ("launchpad", 0),
                ("coin", W),
                ("opt_in", 0),
                ("destination_wallet", W),
            ]),
        ),
    ]
}

fn instruction<'a>(idl: &'a Value, name: &str) -> &'a Value {
    idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("instruction {name} missing from the IDL"))
}

fn flags(account: &Value) -> u8 {
    let s = account["signer"].as_bool().unwrap_or(false);
    let w = account["writable"].as_bool().unwrap_or(false);
    (s as u8) * S + (w as u8) * W
}

/// Section 4: 21 instructions; each one's accounts in the order and with the
/// signer and writable flags of its table.
#[test]
fn idl_accounts_match_the_section_4_tables() {
    let idl = idl();
    let spec = spec_accounts();
    assert_eq!(spec.len(), 21);
    assert_eq!(idl["instructions"].as_array().unwrap().len(), 21);
    for (name, want) in spec {
        let got: Vec<(String, u8)> = instruction(&idl, name)["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a["name"].as_str().unwrap().to_string(), flags(a)))
            .collect();
        let want: Vec<(String, u8)> = want.iter().map(|(n, f)| (n.to_string(), *f)).collect();
        assert_eq!(got, want, "{name}");
    }
}

/// 4.11, 4.12, 14.3: `buy` and `sell` take the same 10 accounts in the same
/// order, with the same flags; no optional account.
#[test]
fn buy_and_sell_share_one_account_list() {
    let idl = idl();
    let strip = |name: &str| -> Vec<Value> {
        instruction(&idl, name)["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| {
                json!({
                    "name": a["name"],
                    "flags": flags(a),
                    "address": a.get("address"),
                    "optional": a.get("optional"),
                })
            })
            .collect()
    };
    let (b, s) = (strip("buy"), strip("sell"));
    assert_eq!(b.len(), 10);
    assert_eq!(b, s);
    assert!(b.iter().all(|a| a["optional"].is_null()));
}

/// Section 4: every instruction's arguments, in order, with their IDL types.
#[test]
fn idl_arguments_match_section_4() {
    let idl = idl();
    let pk = json!("pubkey");
    let u64_ = json!("u64");
    let hash = json!({"array": ["u8", 32]});
    let want: Vec<(&str, Vec<(&str, Value)>)> = vec![
        ("init_launchpad", vec![("guardian", pk.clone())]),
        ("propose_admin", vec![("new_admin", pk.clone())]),
        ("accept_admin", vec![]),
        (
            "set_pause",
            vec![
                ("launches", json!({"option": "bool"})),
                ("payouts", json!({"option": "bool"})),
                ("buys", json!({"option": "bool"})),
                ("buybacks", json!({"option": "bool"})),
            ],
        ),
        ("set_guardian", vec![("guardian", pk.clone())]),
        (
            "set_payout_config",
            vec![
                ("payout_authority", pk.clone()),
                ("payout_destination", pk.clone()),
            ],
        ),
        (
            "add_launch_config",
            vec![("p", json!({"defined": {"name": "ConfigParams"}}))],
        ),
        (
            "set_launch_config_enabled",
            vec![("enabled", json!("bool"))],
        ),
        (
            "approve_launch",
            vec![
                ("city_id", u64_.clone()),
                ("founder", pk.clone()),
                ("config_id", json!("u16")),
                ("name", json!("string")),
                ("symbol", json!("string")),
                ("meta_hash", hash.clone()),
                ("expires_at", json!("i64")),
            ],
        ),
        ("revoke_approval", vec![("city_id", u64_.clone())]),
        ("launch", vec![("city_id", u64_.clone())]),
        (
            "buy",
            vec![("sol_in", u64_.clone()), ("min_tokens_out", u64_.clone())],
        ),
        (
            "sell",
            vec![("tokens_in", u64_.clone()), ("min_sol_out", u64_.clone())],
        ),
        ("buyback_burn", vec![]),
        ("withdraw_platform_fees", vec![]),
        ("forward_holders_fees", vec![]),
        ("claim_founder_fees", vec![]),
        ("transfer_founder", vec![]),
        (
            "opt_in_payout",
            vec![("expected_destination", pk), ("ref_hash", hash)],
        ),
        ("revoke_payout_opt_in", vec![]),
        ("payout_founder_fees", vec![]),
    ];
    assert_eq!(want.len(), 21);
    for (name, args) in want {
        let got = instruction(&idl, name)["args"].as_array().unwrap().clone();
        let want: Vec<Value> = args
            .into_iter()
            .map(|(n, t)| json!({"name": n, "type": t}))
            .collect();
        assert_eq!(got, want, "{name}");
    }
    // ConfigParams (4.6): five u16 shares, then six u64.
    let cp = idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "ConfigParams")
        .unwrap();
    let fields: Vec<(String, String)> = cp["type"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap().to_string(),
                f["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let want: Vec<(String, String)> = [
        ("liquidity_bps", "u16"),
        ("platform_bps", "u16"),
        ("founder_bps", "u16"),
        ("holders_bps", "u16"),
        ("buyback_bps", "u16"),
        ("virtual_sol", "u64"),
        ("virtual_tokens", "u64"),
        ("curve_supply", "u64"),
        ("pool_supply", "u64"),
        ("graduation_sol", "u64"),
        ("launch_fee_lamports", "u64"),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    assert_eq!(fields, want);
}

/// 14.3: the discriminators decoders match on: instructions
/// `sha256("global:<name>")[..8]`, accounts `sha256("account:<Name>")[..8]`
/// (`CurveCoin` for the coin, 3.7), events `sha256("event:<Name>")[..8]`.
#[test]
fn idl_discriminators() {
    let idl = idl();
    let h =
        |s: &str| anchor_lang::solana_program::hash::hash(s.as_bytes()).to_bytes()[..8].to_vec();
    let bytes = |v: &Value| -> Vec<u8> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect()
    };
    for ix in idl["instructions"].as_array().unwrap() {
        let name = ix["name"].as_str().unwrap();
        assert_eq!(bytes(&ix["discriminator"]), h(&format!("global:{name}")));
    }
    let accounts: Vec<&str> = idl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        accounts,
        [
            "Approval",
            "CurveCoin",
            "LaunchConfig",
            "Launchpad",
            "PayoutOptIn",
            "TickerLock"
        ]
    );
    for a in idl["accounts"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        assert_eq!(bytes(&a["discriminator"]), h(&format!("account:{name}")));
    }
    let coin = idl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "CurveCoin")
        .unwrap();
    assert_eq!(
        bytes(&coin["discriminator"]),
        vicinity_curve_math::constants::CURVE_COIN_DISCRIMINATOR.to_vec()
    );
    for e in idl["events"].as_array().unwrap() {
        let name = e["name"].as_str().unwrap();
        assert_eq!(bytes(&e["discriminator"]), h(&format!("event:{name}")));
    }
}

/// 4.21: the eight event-CPI events and the thirteen settings events.
#[test]
fn idl_events() {
    let idl = idl();
    let mut got: Vec<&str> = idl["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    got.sort_unstable();
    let mut want = vec![
        "CoinLaunched",
        "Trade",
        "Graduated",
        "BuybackBurned",
        "PlatformFeesWithdrawn",
        "HoldersFeesForwarded",
        "FounderFeesClaimed",
        "FounderPaidOut",
        "LaunchpadInitialized",
        "AdminProposed",
        "AdminChanged",
        "PauseChanged",
        "GuardianChanged",
        "PayoutConfigChanged",
        "ConfigAdded",
        "ConfigEnabled",
        "LaunchApproved",
        "ApprovalRevoked",
        "FounderTransferred",
        "PayoutOptedIn",
        "PayoutOptInRevoked",
    ];
    want.sort_unstable();
    assert_eq!(got, want);
}

/// 4.22: 56 codes from 6000, contiguous, in the table's order (the first and
/// the last few checked by name; errors.rs checks every code).
#[test]
fn idl_errors() {
    let idl = idl();
    let errors = idl["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 56);
    for (i, e) in errors.iter().enumerate() {
        assert_eq!(e["code"].as_u64().unwrap(), 6000 + i as u64);
    }
    let name = |i: usize| errors[i]["name"].as_str().unwrap();
    assert_eq!(name(0), "Unauthorized");
    assert_eq!(name(43), "TradingHalted");
    assert_eq!(name(44), "MathOverflow");
    assert_eq!(name(49), "BuysHalted");
    assert_eq!(name(50), "BadMetaHash");
    assert_eq!(name(51), "LegacyAdminMismatch");
    assert_eq!(name(52), "FeeRecipientRole");
    assert_eq!(name(53), "FounderHoldsRole");
    assert_eq!(name(54), "BuybacksHalted");
    assert_eq!(name(55), "BuybackHaltWithoutBuyHalt");
}

/// 3.2, C03: the committed IDL is the default (mainnet ids) build's, its
/// address is this crate's id, and its policy constants are the compiled ones.
#[test]
fn idl_address_and_constants() {
    use crate::constants::*;
    let idl = idl();
    assert_eq!(idl["address"].as_str().unwrap(), crate::ID.to_string());
    let constants: std::collections::BTreeMap<String, String> = idl["constants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].as_str().unwrap().to_string(),
                c["value"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let has = |name: &str, value: String| {
        let got = constants
            .get(name)
            .unwrap_or_else(|| panic!("constant {name} missing"));
        assert_eq!(got.trim_matches('"'), value, "{name}");
    };
    has("FEE_RECIPIENT", FEE_RECIPIENT.to_string());
    has(
        "REWARDS_PROGRAM_ID",
        cluster::MAINNET_REWARDS_PROGRAM_ID.to_string(),
    );
    has(
        "LEGACY_PROGRAM_ID",
        cluster::MAINNET_LEGACY_PROGRAM_ID.to_string(),
    );
    has(
        "LEGACY_LAUNCHPAD",
        cluster::MAINNET_LEGACY_LAUNCHPAD.to_string(),
    );
    has("METAPLEX_PROGRAM_ID", METAPLEX_PROGRAM_ID.to_string());
    has("NATIVE_MINT", NATIVE_MINT.to_string());
    has("COIN_SUPPLY", COIN_SUPPLY.to_string());
    has("MAX_TOTAL_FEE_BPS", MAX_TOTAL_FEE_BPS.to_string());
    has("MAX_PLATFORM_FEE_BPS", MAX_PLATFORM_FEE_BPS.to_string());
    has("MAX_FOUNDER_FEE_BPS", MAX_FOUNDER_FEE_BPS.to_string());
    has("MIN_TRADE_LAMPORTS", MIN_TRADE_LAMPORTS.to_string());
    has("BUYBACK_CAP_DIVISOR", BUYBACK_CAP_DIVISOR.to_string());
    has("BUYBACK_INTERVAL_SLOTS", BUYBACK_INTERVAL_SLOTS.to_string());
    has(
        "MAX_LAUNCH_FEE_LAMPORTS",
        MAX_LAUNCH_FEE_LAMPORTS.to_string(),
    );
    has("METADATA_URI_PREFIX", METADATA_URI_PREFIX.to_string());
}
