use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter,
};

pub fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let reset_pos = MenuItem::with_id(app, "reset_position", "Reset Model", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&settings, &reset_pos, &separator, &quit])?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Rive2d")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                crate::create_config_window(app);
            }
            "reset_position" => {
                crate::config::delete_settings(app, &["model_x", "model_y", "model_scale"]);
                app.emit("reset-position", ()).ok();
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
