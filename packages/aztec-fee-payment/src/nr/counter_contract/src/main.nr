use aztec::macros::aztec;

#[aztec]
pub contract Counter {
    // aztec library imports
    use aztec::{
        macros::{functions::{external, only_self, view}, storage::storage},
        state_vars::PublicMutable,
    };

    #[storage]
    struct Storage<Context> {
        counter: PublicMutable<u128, Context>,
    }

    /// @dev Increments the counter
    #[external("private")]
    fn increment() {
        self.enqueue_self.increment_internal();
    }

    /// @dev Retrieves the counter value
    /// @return The current counter value
    #[external("public")]
    #[view]
    fn get_counter() -> u128 {
        self.storage.counter.read()
    }

    /// @dev Increments the counter
    #[external("public")]
    #[only_self]
    fn increment_internal() {
        let current_value = self.storage.counter.read();
        self.storage.counter.write(current_value + 1);
    }
}
