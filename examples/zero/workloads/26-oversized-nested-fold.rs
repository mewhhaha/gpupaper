#![no_std]

fn inner_step(value: i32) -> i32 {
    let mixed = value.wrapping_add(78);
    let square = mixed.wrapping_mul(mixed);
    let cube = square.wrapping_mul(mixed);
    let left = cube.wrapping_mul(3).wrapping_add(square.wrapping_mul(5));
    let right = mixed.wrapping_mul(7).wrapping_add(11);
    let joined = left.wrapping_add(right);
    let twisted = joined.wrapping_mul(mixed).wrapping_add(19);
    twisted
        .wrapping_mul(twisted)
        .wrapping_add(joined)
        .wrapping_add(23)
}

fn step(value: i32) -> i32 {
    let mut remaining = 8;
    let mut state = value;
    while remaining > 0 {
        state = inner_step(state);
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
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
