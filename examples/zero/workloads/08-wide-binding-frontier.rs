#![no_std]

fn step(value: i32) -> i32 {
    let a = value.wrapping_mul(3).wrapping_add(17);
    let b = value.wrapping_mul(5).wrapping_sub(29);
    let c = value.wrapping_mul(7).wrapping_add(43);
    let d = value.wrapping_mul(11).wrapping_sub(61);
    a.wrapping_add(b)
        .wrapping_mul(c.wrapping_sub(d))
        .wrapping_add(a.wrapping_add(d))
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
