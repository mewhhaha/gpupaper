#![no_std]

fn step(value: i32) -> i32 {
    if value == 0 {
        1
    } else {
        1_000_000_000_i32.wrapping_div(value).wrapping_add(17)
    }
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
