#![no_std]

fn shifted(value: i32) -> i32 {
    value.wrapping_add(78)
}

fn step(value: i32) -> i32 {
    let a = shifted(value);
    let b = shifted(value.wrapping_add(1));
    let c = shifted(value.wrapping_add(2));
    let d = shifted(value.wrapping_add(3));
    let e = shifted(value.wrapping_add(4));
    a.wrapping_mul(b)
        .wrapping_add(c.wrapping_mul(d))
        .wrapping_add(e)
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
