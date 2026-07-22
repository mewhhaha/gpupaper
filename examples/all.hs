data Maybe a = Nothing | Just a
class Eq a where eq :: a -> a -> Bool
instance Eq Int where eq = primEqInt

macro makeIdentity = identity
makeIdentity!(generatedId)
macro makeConstant = constant
makeConstant!(macroForty, 40)

fromMaybe fallback value = case value of { Nothing -> fallback; Just x -> x }
gpuConstant = comptime (6 * 7)
interactionConstant = ic ((\x -> x + x) 21)
checked x = if x == interactionConstant then x else macroForty
main = checked (fromMaybe 0 (Just (generatedId gpuConstant)))
