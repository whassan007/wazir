package ai.wazir.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val WazirGold = Color(0xFFD4AF37)
val WazirGoldLight = Color(0xFFF3E5AB)
val WazirCyan = Color(0xFF38BDF8)
val WazirEmerald = Color(0xFF10B981)
val WazirAmber = Color(0xFFF59E0B)
val WazirCrimson = Color(0xFFEF4444)
val WazirSlateDark = Color(0xFF0B0F17)
val WazirSurfaceDark = Color(0xFF131B2E)
val WazirCardDark = Color(0xFF1B253B)

private val DarkPalette = darkColorScheme(
    primary = WazirGold,
    onPrimary = Color(0xFF141100),
    primaryContainer = Color(0xFF3E3100),
    onPrimaryContainer = WazirGoldLight,
    secondary = WazirCyan,
    onSecondary = Color(0xFF001E2C),
    secondaryContainer = Color(0xFF003549),
    onSecondaryContainer = Color(0xFFB8E6FF),
    tertiary = WazirEmerald,
    background = WazirSlateDark,
    onBackground = Color(0xFFE6EDF7),
    surface = WazirSurfaceDark,
    onSurface = Color(0xFFE6EDF7),
    surfaceVariant = WazirCardDark,
    onSurfaceVariant = Color(0xFFB0BED9),
    error = WazirCrimson,
    onError = Color.White,
)

private val LightPalette = lightColorScheme(
    primary = Color(0xFF8C6D00),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFE17D),
    onPrimaryContainer = Color(0xFF2B2000),
    secondary = Color(0xFF0284C7),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE0F2FE),
    onSecondaryContainer = Color(0xFF075985),
    tertiary = Color(0xFF059669),
    background = Color(0xFFF8FAFC),
    onBackground = Color(0xFF0F172A),
    surface = Color.White,
    onSurface = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFEFF4FA),
    onSurfaceVariant = Color(0xFF475569),
    error = Color(0xFFDC2626),
    onError = Color.White,
)

@Composable
fun WazirMobileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkPalette else LightPalette
    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
