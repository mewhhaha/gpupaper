#![no_std]

fn step(value: i32) -> i32 {
    let mixed = value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    if mixed < 0 { mixed.wrapping_add(12_345) } else { mixed.wrapping_sub(12_345) }
}

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut remaining = rounds;
    let mut state = seed;
    while remaining > 0 {
        state = step(state);
        remaining -= 1;
    }
    state
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
