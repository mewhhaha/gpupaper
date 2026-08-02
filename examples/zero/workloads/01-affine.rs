#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut remaining = rounds;
    let mut state = seed;
    while remaining > 0 {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        remaining -= 1;
    }
    state
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
