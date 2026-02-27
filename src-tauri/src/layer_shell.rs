use gtk::glib;
use gtk::prelude::*;
use gtk_layer_shell::LayerShell;
use tauri::Manager;

pub fn setup_layer_shell(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    setup_layer_shell_window(&main_window)
}

pub fn setup_layer_shell_from_handle(
    app: &tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    setup_layer_shell_window(&main_window)
}

fn setup_layer_shell_window(
    main_window: &tauri::WebviewWindow,
) -> Result<(), Box<dyn std::error::Error>> {
    // Hide the original Tauri-managed window
    main_window.hide()?;

    // Get the original GTK window and its application
    let original_gtk_window = main_window.gtk_window()?;
    let gtk_app = original_gtk_window
        .application()
        .ok_or("Failed to get GTK Application")?;

    // Create a NEW ApplicationWindow (not yet realized)
    let new_gtk_window = gtk::ApplicationWindow::new(&gtk_app);

    // Set up transparency BEFORE realization
    new_gtk_window.set_app_paintable(true);
    if let Some(screen) = WidgetExt::screen(&new_gtk_window) {
        if let Some(visual) = screen.rgba_visual() {
            new_gtk_window.set_visual(Some(&visual));
        }
    }

    // Transfer the webview vbox from original window to new window
    let vbox = main_window.default_vbox()?;
    original_gtk_window.remove(&vbox);
    new_gtk_window.add(&vbox);

    // Initialize layer shell BEFORE the window is realized
    new_gtk_window.init_layer_shell();

    // Configure layer shell properties
    new_gtk_window.set_layer(gtk_layer_shell::Layer::Bottom);
    new_gtk_window.set_exclusive_zone(-1);
    new_gtk_window.set_keyboard_mode(gtk_layer_shell::KeyboardMode::None);
    new_gtk_window.set_namespace("rive2d-desktop-pet");

    // Set window size
    new_gtk_window.set_width_request(512);
    new_gtk_window.set_height_request(512);

    // Paint transparent background
    new_gtk_window.connect_draw(|_window, ctx| {
        ctx.set_source_rgba(0.0, 0.0, 0.0, 0.0);
        ctx.set_operator(gtk::cairo::Operator::Source);
        ctx.paint().expect("Failed to paint transparent background");
        glib::Propagation::Proceed
    });

    // Show the new window (this triggers realization with layer-shell active)
    new_gtk_window.show_all();

    Ok(())
}
