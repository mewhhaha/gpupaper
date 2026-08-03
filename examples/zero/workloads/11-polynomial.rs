#![no_std]

fn step(value: i32) -> i32 {
    let mixed = value.wrapping_add(78);
    mixed
        .wrapping_mul(mixed)
        .wrapping_mul(3)
        .wrapping_add(mixed.wrapping_mul(5))
        .wrapping_add(17)
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
