package ai.wazir.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Authoritative Wazir CVI Palette (`assets/brand/Wazir_CVI_Guidelines.pdf`)
val WazirDarkAbyss = Color(0xFF0F131A)
val WazirElectricBlue = Color(0xFF38BDF8)
val WazirCyanGlow = Color(0xFF67E8F9)
val WazirMetallicSilver = Color(0xFF94A3B8)
val WazirDataGreen = Color(0xFF22C55E)
val WazirIceWhite = Color(0xFFF8FAFC)
val WazirShieldNavy = Color(0xFF162032)
val WazirShieldSteel = Color(0xFF2F4469)

// Backward-compatible semantic aliases
val WazirGold = WazirElectricBlue
val WazirGoldLight = WazirCyanGlow
val WazirCyan = WazirElectricBlue
val WazirEmerald = WazirDataGreen
val WazirAmber = Color(0xFFF59E0B)
val WazirCrimson = Color(0xFFEF4444)
val WazirSlateDark = WazirDarkAbyss
val WazirSurfaceDark = WazirShieldNavy
val WazirCardDark = Color(0xFF1E293B)

private val DarkPalette = darkColorScheme(
    primary = WazirElectricBlue,
    onPrimary = WazirDarkAbyss,
    primaryContainer = WazirShieldSteel,
    onPrimaryContainer = WazirIceWhite,
    secondary = WazirMetallicSilver,
    onSecondary = WazirDarkAbyss,
    secondaryContainer = Color(0xFF1E293B),
    onSecondaryContainer = WazirIceWhite,
    tertiary = WazirDataGreen,
    background = WazirDarkAbyss,
    onBackground = WazirIceWhite,
    surface = WazirShieldNavy,
    onSurface = WazirIceWhite,
    surfaceVariant = WazirCardDark,
    onSurfaceVariant = WazirMetallicSilver,
    error = WazirCrimson,
    onError = Color.White,
)

private val LightPalette = lightColorScheme(
    primary = Color(0xFF0284C7),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0F2FE),
    onPrimaryContainer = Color(0xFF0C4A6E),
    secondary = Color(0xFF475569),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE2E8F0),
    onSecondaryContainer = Color(0xFF1E293B),
    tertiary = Color(0xFF16A34A),
    background = WazirIceWhite,
    onBackground = WazirDarkAbyss,
    surface = Color.White,
    onSurface = WazirDarkAbyss,
    surfaceVariant = Color(0xFFF1F5F9),
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
