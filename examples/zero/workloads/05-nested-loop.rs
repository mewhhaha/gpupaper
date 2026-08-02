#![no_std]

fn inner(seed: i32) -> i32 {
    let mut state = seed;
    let mut remaining = 4;
    while remaining > 0 {
        let mixed = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        state = if mixed < 0 { mixed.wrapping_add(97) } else { mixed.wrapping_sub(89) };
        remaining -= 1;
    }
    state
}

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut remaining = rounds;
    let mut state = seed;
    while remaining > 0 {
        state = inner(state);
        remaining -= 1;
    }
    state
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
