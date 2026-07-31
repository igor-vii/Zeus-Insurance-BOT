// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockERC20
 * @dev Упрощенный ERC20 токен для тестирования страховок в стейблах.
 */
contract MockERC20 is ERC20, Ownable {
    constructor() ERC20("Mock USDC", "USDC") Ownable(msg.sender) {
        // Минтим 1,000,000 токенов деплоеру (admin)
        _mint(msg.sender, 1_000_000 * 10**18);
    }

    /**
     * @dev Минт токенов на любой адрес. Доступен только владельцу (admin).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
