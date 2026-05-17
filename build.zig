const std = @import("std");

/// Library build: produces just the WASM artifact and a placeholder JS file
/// (the real JS wrapper is written by hand in src/zflow.js and copied to
/// dist/ by this step). No Zaui linkage, no desktop binary — this folder is
/// the library proper.
pub fn build(b: *std.Build) void {
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    const wasm_mod = b.createModule(.{
        .root_source_file = b.path("src/core.zig"),
        .target = wasm_target,
        .optimize = .ReleaseFast,
    });
    const wasm = b.addExecutable(.{
        .name = "zflow",
        .root_module = wasm_mod,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;

    const install_wasm = b.addInstallFileWithDir(wasm.getEmittedBin(), .{ .custom = "../dist" }, "zflow.wasm");
    const install_js = b.addInstallFileWithDir(b.path("src/zflow.js"), .{ .custom = "../dist" }, "zflow.js");
    const install_gl = b.addInstallFileWithDir(b.path("src/webgl-renderer.js"), .{ .custom = "../dist" }, "webgl-renderer.js");
    const install_yjs = b.addInstallFileWithDir(b.path("src/adapters/yjs.js"), .{ .custom = "../dist/adapters" }, "yjs.js");

    b.getInstallStep().dependOn(&install_wasm.step);
    b.getInstallStep().dependOn(&install_js.step);
    b.getInstallStep().dependOn(&install_gl.step);
    b.getInstallStep().dependOn(&install_yjs.step);

    // `zig build serve` → launches python http.server in examples/
    const serve = b.addSystemCommand(&.{
        "python", "-m", "http.server", "8765", "--directory", ".",
    });
    serve.step.dependOn(b.getInstallStep());
    const serve_step = b.step("serve", "Build dist/ and serve examples/ on :8765");
    serve_step.dependOn(&serve.step);
}
