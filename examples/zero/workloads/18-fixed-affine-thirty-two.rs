#![no_std]

fn inner(value: i32) -> i32 {
    value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223)
}

fn step(value: i32) -> i32 {
    let mut remaining = 32;
    let mut state = value;
    while remaining > 0 {
        state = inner(state);
        remaining -= 1;
    }
    state
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
