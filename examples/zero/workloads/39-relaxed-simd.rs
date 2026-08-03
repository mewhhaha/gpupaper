#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let selected = if seed < 0 { seed } else { rounds };
    selected.wrapping_add(31).wrapping_add(10)
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
