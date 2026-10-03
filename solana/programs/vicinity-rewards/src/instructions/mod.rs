//! One file per instruction. Each file holds the Anchor account struct (all
//! constraints) and a uniquely named `handle_<instruction>` function (unique so
//! the glob re-exports below, which Anchor's `#[program]` macro needs, never collide).

pub mod accept_authority;
pub mod cancel_epoch;
pub mod claim;
pub mod close_claim_status;
pub mod fund_epoch;
pub mod init_city;
pub mod lock_config;
pub mod pause;
pub mod propose_authority;
pub mod set_founder;
pub mod sweep_epoch;
pub mod unpause;

pub use accept_authority::*;
pub use cancel_epoch::*;
pub use claim::*;
pub use close_claim_status::*;
pub use fund_epoch::*;
pub use init_city::*;
pub use lock_config::*;
pub use pause::*;
pub use propose_authority::*;
pub use set_founder::*;
pub use sweep_epoch::*;
pub use unpause::*;
